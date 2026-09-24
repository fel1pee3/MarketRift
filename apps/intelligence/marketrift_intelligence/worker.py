import asyncio
import logging
import os
import signal

from bullmq import Worker

from .ingest import ingest, mark_failed

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


async def main() -> None:
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for event in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(event, stop.set)
        except NotImplementedError:  # Windows event loop
            signal.signal(event, lambda *_: loop.call_soon_threadsafe(stop.set))
    worker = Worker("review-ingest", process, {"connection": os.environ["REDIS_URL"]})
    try:
        await stop.wait()
    finally:
        await worker.close()


if __name__ == "__main__":
    if os.name == "nt":
        asyncio.run(main(), loop_factory=asyncio.SelectorEventLoop)
    else:
        asyncio.run(main())
