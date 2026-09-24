import asyncio
import logging
import os
import signal

from bullmq import Worker

from .analyze import analyze
from .github_issues import sync_github_issues
from .ingest import ingest, mark_failed
from .steam_reviews import sync_steam_reviews

logger = logging.getLogger(__name__)


async def process(job, _token):
    try:
        return await ingest(job.data)
    except Exception as error:
        try:
            await mark_failed(job.data, type(error).__name__)
        except Exception as mark_error:  # noqa: BLE001 - preserve the original job failure
            logger.warning("Could not mark import failed: %s", type(mark_error).__name__)
        raise


async def process_analysis(job, _token):
    return await analyze(job.data)


async def process_github(job, _token):
    return await sync_github_issues(job.data)


async def process_steam(job, _token):
    result = await sync_steam_reviews(job.data)
    if result.get("status") == "failed":
        logger.warning("Steam sync failed: run=%s source=%s code=%s",
                       job.data.get("run_id"), job.data.get("source_id"), result.get("error_code"))
    return result


async def main() -> None:
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for event in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(event, stop.set)
        except NotImplementedError:  # Windows event loop
            signal.signal(event, lambda *_: loop.call_soon_threadsafe(stop.set))
    worker = Worker("review-ingest", process, {"connection": os.environ["REDIS_URL"]})
    analysis_worker = Worker("review-analysis", process_analysis, {"connection": os.environ["REDIS_URL"]})
    github_worker = Worker("github-issues", process_github, {"connection": os.environ["REDIS_URL"]})
    steam_worker = Worker("steam-reviews", process_steam, {"connection": os.environ["REDIS_URL"]})
    try:
        await stop.wait()
    finally:
        await asyncio.gather(worker.close(), analysis_worker.close(), github_worker.close(), steam_worker.close())


if __name__ == "__main__":
    if os.name == "nt":
        asyncio.run(main(), loop_factory=asyncio.SelectorEventLoop)
    else:
        asyncio.run(main())
