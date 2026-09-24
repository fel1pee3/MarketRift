import os
from typing import Any

import psycopg

from .analysis_queue import publish_analyses
from .extract import EXTRACTOR_VERSION
from .job import validate_job


async def ingest(payload: object) -> dict[str, Any]:
    job = validate_job(payload)
    database_url = os.environ["RUNTIME_DATABASE_URL"]
    extractor_version = os.getenv("EXTRACTOR_VERSION", EXTRACTOR_VERSION)
    async with await psycopg.AsyncConnection.connect(database_url) as connection:
        async with connection.transaction():
            await connection.execute("SELECT set_config('app.tenant_id', %s, true)", (job["tenant_id"],))
            # RLS and explicit source/import checks must both succeed, including on replay.
            source = await (
                await connection.execute(
                    "SELECT id FROM marketrift.sources WHERE tenant_id = %s AND id = %s "
                    "AND source_type = 'manual_review'",
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
            replayed = imported[1] == "completed"
            rows = await (
                await connection.execute(
                    "SELECT external_key, source_url, published_at, body, synthetic FROM marketrift.import_rows "
                    "WHERE tenant_id = %s AND import_id = %s ORDER BY external_key",
                    (job["tenant_id"], job["import_id"]),
                )
            ).fetchall()
            new_documents = 0
            if not replayed:
                await connection.execute(
                    "UPDATE marketrift.imports SET status = 'processing', last_error = NULL "
                    "WHERE tenant_id = %s AND id = %s",
                    (job["tenant_id"], job["import_id"]),
                )
                for external_key, source_url, published_at, body, synthetic in rows:
                    cursor = await connection.execute(
                        "INSERT INTO marketrift.documents "
                        "(tenant_id, source_id, document_type, external_key, source_url, published_at, body, synthetic) "
                        "VALUES (%s, %s, 'review', %s, %s, %s, %s, %s) "
                        "ON CONFLICT (tenant_id, source_id, external_key) DO NOTHING RETURNING id",
                        (job["tenant_id"], job["source_id"], external_key, source_url, published_at,
                         body, synthetic),
                    )
                    if await cursor.fetchone() is not None:
                        new_documents += 1
                await connection.execute(
                    "UPDATE marketrift.imports SET status = 'completed', processed_rows = %s, finished_at = now() "
                    "WHERE tenant_id = %s AND id = %s",
                    (len(rows), job["tenant_id"], job["import_id"]),
                )
            document_ids = []
            for external_key, *_ in rows:
                document = await (
                    await connection.execute(
                        "SELECT id FROM marketrift.documents WHERE tenant_id = %s AND source_id = %s "
                        "AND external_key = %s AND document_type = 'review'",
                        (job["tenant_id"], job["source_id"], external_key),
                    )
                ).fetchone()
                if document is None:
                    raise ValueError("import row document missing")
                document_id = str(document[0])
                await connection.execute(
                    "INSERT INTO marketrift.document_analyses (tenant_id, document_id, extractor_version) "
                    "VALUES (%s, %s, %s) ON CONFLICT (tenant_id, document_id, extractor_version) DO NOTHING",
                    (job["tenant_id"], document_id, extractor_version),
                )
                status = await (
                    await connection.execute(
                        "SELECT status FROM marketrift.document_analyses WHERE tenant_id = %s "
                        "AND document_id = %s AND extractor_version = %s",
                        (job["tenant_id"], document_id, extractor_version),
                    )
                ).fetchone()
                if status[0] in ("pending", "failed"):
                    document_ids.append(document_id)
        # The document and analysis row are committed before their IDs enter Redis.
        # If publishing fails, BullMQ retries ingestion and this replay path republishes pending rows.
        await publish_analyses(job["tenant_id"], document_ids)
        return {"status": "completed", "new_documents": new_documents, "replayed": replayed,
                "analysis_queued": len(document_ids)}


async def mark_failed(payload: object, error_code: str) -> None:
    job = validate_job(payload)
    async with await psycopg.AsyncConnection.connect(os.environ["RUNTIME_DATABASE_URL"]) as connection:
        await connection.execute("SELECT set_config('app.tenant_id', %s, true)", (job["tenant_id"],))
        await connection.execute(
            "UPDATE marketrift.imports SET status = 'failed', last_error = %s "
            "WHERE tenant_id = %s AND id = %s AND source_id = %s AND status <> 'completed'",
            (error_code, job["tenant_id"], job["import_id"], job["source_id"]),
        )
