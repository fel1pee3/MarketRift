"""Recheck a scheduled GitHub run immediately before each external request."""

import os

import psycopg


async def ensure_scheduled_run(job: dict, source_type: str, source_url: str) -> None:
    generation = job.get("monitor_generation")
    if generation is None:
        return  # The existing manual path has no monitoring revision.
    async with await psycopg.AsyncConnection.connect(os.environ["RUNTIME_DATABASE_URL"]) as connection:
        await connection.execute("SELECT set_config('app.tenant_id', %s, true)", (job["tenant_id"],))
        row = await (await connection.execute(
            "SELECT 1 FROM marketrift.source_runs r JOIN marketrift.sources s "
            "ON s.tenant_id=r.tenant_id AND s.id=r.source_id "
            "JOIN marketrift.products p ON p.tenant_id=s.tenant_id AND p.id=s.product_id "
            "WHERE r.tenant_id=%s AND r.id=%s AND r.source_id=%s AND r.status='running' "
            "AND r.trigger_kind='scheduled' AND r.github_monitor_generation=%s "
            "AND s.github_monitor_generation=%s AND s.monitoring_enabled AND s.enabled "
            "AND s.source_type=%s AND s.url=%s",
            (job["tenant_id"], job["run_id"], job["source_id"], generation, generation,
             source_type, source_url),
        )).fetchone()
        if row is None:
            from .github_issues import CollectionError
            raise CollectionError("monitoring_changed")
