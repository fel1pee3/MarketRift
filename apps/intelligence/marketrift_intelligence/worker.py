import asyncio
import logging
import os
import signal

from bullmq import Worker

from .analyze import analyze
from .evidence_index import index_source
from .evidence_queue import publish_index
from .g2_reviews import sync_g2_reviews
from .github_discussions import sync_github_discussions
from .github_issues import sync_github_issues
from .ingest import ingest, mark_failed
from .steam_reviews import sync_steam_reviews
from .web_pages import check_web_page, e2e_fetch_public_page

logger = logging.getLogger(__name__)


async def index_after(job, result):
    if result.get("status") in ("completed", "succeeded"):
        await publish_index(job.data["tenant_id"], job.data["source_id"],
                            job.data.get("run_id", job.data.get("import_id", job.id)))
    return result


async def process(job, _token):
    try:
        return await index_after(job, await ingest(job.data))
    except Exception as error:
        try:
            await mark_failed(job.data, type(error).__name__)
        except Exception as mark_error:  # noqa: BLE001 - preserve the original job failure
            logger.warning("Could not mark import failed: %s", type(mark_error).__name__)
        raise


async def process_analysis(job, _token):
    return await analyze(job.data)


async def process_github(job, _token):
    return await index_after(job, await sync_github_issues(job.data))


async def process_discussions(job, _token):
    result = await sync_github_discussions(job.data)
    if result.get("status") == "failed":
        logger.warning("Discussion sync failed: run=%s source=%s code=%s",
                       job.data.get("run_id"), job.data.get("source_id"), result.get("error_code"))
    return await index_after(job, result)


async def process_steam(job, _token):
    result = await sync_steam_reviews(job.data)
    if result.get("status") == "failed":
        logger.warning("Steam sync failed: run=%s source=%s code=%s",
                       job.data.get("run_id"), job.data.get("source_id"), result.get("error_code"))
    return await index_after(job, result)


async def process_g2(job, _token):
    result = await sync_g2_reviews(job.data)
    if result.get("status") == "failed":
        logger.warning("G2 sync failed: run=%s source=%s code=%s",
                       job.data.get("run_id"), job.data.get("source_id"), result.get("error_code"))
    return await index_after(job, result)


async def process_web_page(job, _token):
    fetcher = e2e_fetch_public_page if os.getenv("MARKETRIFT_TEST_MODE") == "1" and os.getenv("WEB_PAGE_TEST_BASE_URL") else None
    result = await check_web_page(job.data, fetcher=fetcher) if fetcher else await check_web_page(job.data)
    if result.get("status") == "failed":
        logger.warning("Page check failed: run=%s source=%s code=%s",
                       job.data.get("run_id"), job.data.get("source_id"), result.get("error_code"))
    return await index_after(job, result)


async def process_index(job, _token):
    return await index_source(job.data)


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
    discussions_worker = Worker("github-discussions", process_discussions, {"connection": os.environ["REDIS_URL"]})
    steam_worker = Worker("steam-reviews", process_steam, {"connection": os.environ["REDIS_URL"]})
    g2_worker = Worker("g2-reviews", process_g2, {"connection": os.environ["REDIS_URL"]})
    web_page_worker = Worker("web-pages", process_web_page, {"connection": os.environ["REDIS_URL"]})
    index_worker = Worker("evidence-index", process_index, {"connection": os.environ["REDIS_URL"]})
    try:
        await stop.wait()
    finally:
        await asyncio.gather(worker.close(), analysis_worker.close(), github_worker.close(), discussions_worker.close(),
                             steam_worker.close(), g2_worker.close(), web_page_worker.close(), index_worker.close())


if __name__ == "__main__":
    if os.name == "nt":
        asyncio.run(main(), loop_factory=asyncio.SelectorEventLoop)
    else:
        asyncio.run(main())
