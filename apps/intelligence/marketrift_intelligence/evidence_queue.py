import os

from bullmq import Queue


async def publish_index(tenant_id: str, source_id: str, event_id: str) -> None:
    queue = Queue("evidence-index", {"connection": os.environ["REDIS_URL"]})
    try:
        key = f"index:{source_id}:{event_id}"
        await queue.add("index-evidence.v1", {
            "contract_version": "index-evidence.v1", "tenant_id": tenant_id,
            "source_id": source_id, "idempotency_key": key,
        }, {"jobId": key, "attempts": 3,
            "backoff": {"type": "exponential", "delay": 1000},
            "removeOnComplete": True, "removeOnFail": True})
    finally:
        await queue.close()
