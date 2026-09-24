import os
from typing import Any

import psycopg

from .analysis_job import validate_analysis_job
from .extract import (
    EXTRACTOR_VERSION,
    PROMPT_VERSION,
    SCHEMA_VERSION,
    TAXONOMY_VERSION,
    extract_review,
    model_id,
    provider_available,
    validate_extraction,
)


async def analyze(payload: object) -> dict[str, Any]:
    job = validate_analysis_job(payload)
    if job["extractor_version"] != os.getenv("EXTRACTOR_VERSION", EXTRACTOR_VERSION):
        raise ValueError("worker extractor version does not match job")
    database_url = os.environ["RUNTIME_DATABASE_URL"]
    async with await psycopg.AsyncConnection.connect(database_url) as connection:
        async with connection.transaction():
            await connection.execute("SELECT set_config('app.tenant_id', %s, true)", (job["tenant_id"],))
            row = await (
                await connection.execute(
                    "SELECT a.id, a.status, d.body "
                    "FROM marketrift.document_analyses a "
                    "JOIN marketrift.documents d ON d.tenant_id = a.tenant_id AND d.id = a.document_id "
                    "WHERE a.tenant_id = %s AND a.document_id = %s AND a.extractor_version = %s "
                    "AND d.document_type IN ('review', 'steam_review') FOR UPDATE OF a",
                    (job["tenant_id"], job["document_id"], job["extractor_version"]),
                )
            ).fetchone()
            if row is None:
                raise ValueError("analysis document does not belong to job tenant")
            analysis_id, status, body = row
            if status == "completed":
                return {"status": "completed", "replayed": True}
            # A retry may supersede a crashed attempt. attempt_count prevents an older
            # in-flight provider call from publishing after the newer claim.
            attempt_row = await (
                await connection.execute(
                    "UPDATE marketrift.document_analyses SET status = 'processing', attempt_count = attempt_count + 1, "
                    "model_id = %s, prompt_version = %s, schema_version = %s, taxonomy_version = %s, "
                    "started_at = now(), completed_at = NULL, last_error = NULL "
                    "WHERE tenant_id = %s AND id = %s RETURNING attempt_count",
                    (model_id(), PROMPT_VERSION, SCHEMA_VERSION, TAXONOMY_VERSION,
                     job["tenant_id"], analysis_id),
                )
            ).fetchone()
            attempt = attempt_row[0]

        if not provider_available():
            await _set_status(connection, job["tenant_id"], analysis_id, attempt, "unavailable",
                              "AnalysisProviderUnavailable")
            return {"status": "unavailable", "replayed": False}

        try:
            result = validate_extraction(body, await extract_review(body))
        except Exception as error:  # noqa: BLE001 - provider and parser failures must be recorded safely
            await _set_status(connection, job["tenant_id"], analysis_id, attempt, "failed", type(error).__name__)
            # BullMQ stores exception messages. Never put raw review or provider responses there.
            raise RuntimeError(type(error).__name__) from None

        async with connection.transaction():
            await connection.execute("SELECT set_config('app.tenant_id', %s, true)", (job["tenant_id"],))
            claimed = await (
                await connection.execute(
                    "SELECT id FROM marketrift.document_analyses WHERE tenant_id = %s AND id = %s "
                    "AND attempt_count = %s AND status = 'processing' FOR UPDATE",
                    (job["tenant_id"], analysis_id, attempt),
                )
            ).fetchone()
            if claimed is None:
                return {"status": "superseded", "replayed": True}
            await connection.execute(
                "DELETE FROM marketrift.insights WHERE tenant_id = %s AND analysis_id = %s",
                (job["tenant_id"], analysis_id),
            )
            for index, issue in enumerate(result.issues):
                await connection.execute(
                    "INSERT INTO marketrift.insights "
                    "(tenant_id, document_id, analysis_id, issue_index, sentiment, category, pain_point, "
                    "severity, evidence_quote, extractor_version) "
                    "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
                    (job["tenant_id"], job["document_id"], analysis_id, index, issue.sentiment,
                     issue.category, issue.description, issue.severity, issue.evidence_quote,
                     job["extractor_version"]),
                )
            await connection.execute(
                "UPDATE marketrift.document_analyses SET status = 'completed', completed_at = now(), "
                "last_error = NULL WHERE tenant_id = %s AND id = %s",
                (job["tenant_id"], analysis_id),
            )
        return {"status": "completed", "issues": len(result.issues), "replayed": False}


async def _set_status(connection, tenant_id, analysis_id, attempt, status, error_code):
    async with connection.transaction():
        await connection.execute("SELECT set_config('app.tenant_id', %s, true)", (tenant_id,))
        await connection.execute(
            "UPDATE marketrift.document_analyses SET status = %s, last_error = %s, completed_at = now() "
            "WHERE tenant_id = %s AND id = %s AND attempt_count = %s AND status = 'processing'",
            (status, error_code, tenant_id, analysis_id, attempt),
        )
