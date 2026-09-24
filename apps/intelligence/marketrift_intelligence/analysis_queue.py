import os

from bullmq import Queue

from .analysis_job import make_analysis_job
from .extract import EXTRACTOR_VERSION


async def publish_analyses(tenant_id: str, document_ids: list[str]) -> None:
    if not document_ids:
        return
    queue = Queue("review-analysis", {"connection": os.environ["REDIS_URL"]})
    try:
        for document_id in document_ids:
            job = make_analysis_job(
                tenant_id, document_id, os.getenv("EXTRACTOR_VERSION", EXTRACTOR_VERSION)
            )
            await queue.add("analyze-document.v1", job, {
                "jobId": job["idempotency_key"],
                "attempts": 3,
                "backoff": {"type": "exponential", "delay": 1000},
                "removeOnComplete": True,
                "removeOnFail": True,
            })
    finally:
        await queue.close()
