import os
from typing import Any

import psycopg

from .job import validate_job


async def ingest(payload: object) -> dict[str, Any]:
    job = validate_job(payload)
    database_url = os.environ["RUNTIME_DATABASE_URL"]
    async with await psycopg.AsyncConnection.connect(database_url) as connection, connection.transaction():
        await connection.execute("SELECT set_config('app.tenant_id', %s, true)", (job["tenant_id"],))
        # RLS and the explicit source/import checks both have to succeed.
        source = await (
            await connection.execute(
                "SELECT id FROM marketrift.sources WHERE tenant_id = %s AND id = %s AND source_type = 'manual_review'",
                (job["tenant_id"], job["source_id"]),
            )
        ).fetchone()
        if source is None:
            raise ValueError("source does not belong to job tenant")
        imported = await (
            await connection.execute(
                "SELECT source_id, status FROM marketrift.imports WHERE tenant_id = %s AND id = %s FOR UPDATE",
                (job["tenant_id"], job["import_id"]),
            )
        ).fetchone()
        if imported is None or str(imported[0]) != job["source_id"]:
            raise ValueError("import does not belong to job source and tenant")
        if imported[1] == "completed":
            return {"status": "completed", "new_documents": 0, "replayed": True}
        await connection.execute(
            "UPDATE marketrift.imports SET status = 'processing', last_error = NULL WHERE tenant_id = %s AND id = %s",
            (job["tenant_id"], job["import_id"]),
        )
        rows = await (
            await connection.execute(
                "SELECT external_key, source_url, published_at, body, synthetic FROM marketrift.import_rows "
                "WHERE tenant_id = %s AND import_id = %s ORDER BY external_key",
                (job["tenant_id"], job["import_id"]),
            )
        ).fetchall()
        new_documents = 0
        for external_key, source_url, published_at, body, synthetic in rows:
            cursor = await connection.execute(
                "INSERT INTO marketrift.documents "
                "(tenant_id, source_id, document_type, external_key, source_url, published_at, body, synthetic) "
                "VALUES (%s, %s, 'review', %s, %s, %s, %s, %s) "
                "ON CONFLICT (tenant_id, source_id, external_key) DO NOTHING RETURNING id",
                (job["tenant_id"], job["source_id"], external_key, source_url, published_at, body, synthetic),
            )
            if await cursor.fetchone() is not None:
                new_documents += 1
        await connection.execute(
            "UPDATE marketrift.imports SET status = 'completed', processed_rows = %s, finished_at = now() "
            "WHERE tenant_id = %s AND id = %s",
            (len(rows), job["tenant_id"], job["import_id"]),
        )
        return {"status": "completed", "new_documents": new_documents, "replayed": False}


async def mark_failed(payload: object, error_code: str) -> None:
    job = validate_job(payload)
    async with await psycopg.AsyncConnection.connect(os.environ["RUNTIME_DATABASE_URL"]) as connection:
        await connection.execute("SELECT set_config('app.tenant_id', %s, true)", (job["tenant_id"],))
        await connection.execute(
            "UPDATE marketrift.imports SET status = 'failed', last_error = %s "
            "WHERE tenant_id = %s AND id = %s AND source_id = %s AND status <> 'completed'",
            (error_code, job["tenant_id"], job["import_id"], job["source_id"]),
        )
