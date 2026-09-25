import os
from decimal import Decimal, InvalidOperation
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


async def _b2b_rights_current(connection, job: dict, analysis_id, attempt: int) -> bool:
    """Lock rights and document while deciding whether this attempt may run/publish."""
    row = await (await connection.execute(
        "SELECT a.id FROM marketrift.sources s "
        "JOIN marketrift.documents d ON d.tenant_id = s.tenant_id AND d.source_id = s.id "
        "JOIN marketrift.document_analyses a ON a.tenant_id = d.tenant_id AND a.document_id = d.id "
        "WHERE s.tenant_id = %s AND d.id = %s AND a.id = %s AND a.attempt_count = %s "
        "AND a.status = 'processing' AND s.enabled AND s.storage_permitted "
        "AND s.source_type = 'b2b_csv_review' AND d.document_type = 'b2b_review' "
        "AND ((a.requested_provider = 'test' AND d.synthetic "
        "AND d.review_data_status = 'synthetic_fixture' AND s.access_environment = 'sandbox') "
        "OR (a.requested_provider = 'openai' AND NOT d.synthetic "
        "AND d.review_data_status = 'declared_real' AND s.access_environment = 'production' "
        "AND s.external_ai_permitted AND s.ai_provider = 'openai' "
        "AND s.ai_rights_reference IS NOT NULL AND s.ai_rights_expires_at > now() "
        "AND s.ai_rights_revoked_at IS NULL)) FOR SHARE OF s, d, a",
        (job["tenant_id"], job["document_id"], analysis_id, attempt),
    )).fetchone()
    return row is not None


def _paid_b2b_ready(body: str, model: str | None, tokens: int | None, budget,
                    provider: str | None) -> bool:
    if provider != "openai" or os.getenv("B2B_PAID_ANALYSIS_ENABLED") != "1":
        return False
    if model != os.getenv("ANALYSIS_MODEL", "gpt-5-nano") or not provider_available("openai"):
        return False
    if tokens is None or not 128 <= tokens <= 512 or budget is None:
        return False
    try:
        input_rate = Decimal(os.environ["B2B_INPUT_USD_PER_MILLION"])
        output_rate = Decimal(os.environ["B2B_OUTPUT_USD_PER_MILLION"])
        allowed = Decimal(budget)
    except (KeyError, InvalidOperation, TypeError):
        return False
    if not all(value.is_finite() and value > 0 for value in (input_rate, output_rate, allowed)):
        return False
    # Same conservative per-operation reserve as the API; actual billing can differ.
    reserve = (Decimal(4 * len(body.encode("utf-8")) + 12000) * input_rate
               + Decimal(tokens) * output_rate) / Decimal(1_000_000)
    return reserve <= allowed <= Decimal("0.05")


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
                    "SELECT a.id, a.status, d.body, d.document_type, a.requested_provider, "
                    "a.requested_model, a.max_output_tokens, a.budget_usd "
                    "FROM marketrift.document_analyses a "
                    "JOIN marketrift.documents d ON d.tenant_id = a.tenant_id AND d.id = a.document_id "
                    "WHERE a.tenant_id = %s AND a.document_id = %s AND a.extractor_version = %s "
                    "AND d.document_type IN ('review', 'steam_review', 'b2b_review') FOR UPDATE OF a",
                    (job["tenant_id"], job["document_id"], job["extractor_version"]),
                )
            ).fetchone()
            if row is None:
                raise ValueError("analysis document does not belong to job tenant")
            analysis_id, status, body, document_type, requested_provider, requested_model, tokens, budget = row
            if status == "completed":
                return {"status": "completed", "replayed": True}
            b2b = document_type == "b2b_review"
            if b2b and status != "pending":
                return {"status": status, "replayed": True}
            # A retry may supersede a crashed attempt. attempt_count prevents an older
            # in-flight provider call from publishing after the newer claim.
            attempt_row = await (
                await connection.execute(
                    "UPDATE marketrift.document_analyses SET status = 'processing', attempt_count = attempt_count + 1, "
                    "model_id = %s, prompt_version = %s, schema_version = %s, taxonomy_version = %s, "
                    "started_at = now(), completed_at = NULL, last_error = NULL "
                    "WHERE tenant_id = %s AND id = %s RETURNING attempt_count",
                    (requested_model if b2b else model_id(), PROMPT_VERSION, SCHEMA_VERSION, TAXONOMY_VERSION,
                     job["tenant_id"], analysis_id),
                )
            ).fetchone()
            attempt = attempt_row[0]

        if b2b and requested_provider == "openai" and not _paid_b2b_ready(
                body, requested_model, tokens, budget, requested_provider):
            await _set_status(connection, job["tenant_id"], analysis_id, attempt, "unavailable",
                              "PaidAnalysisConfigurationUnavailable")
            return {"status": "unavailable", "replayed": False}
        if b2b and requested_provider not in ("test", "openai"):
            await _set_status(connection, job["tenant_id"], analysis_id, attempt, "unavailable",
                              "B2BAnalysisOperationMissing")
            return {"status": "unavailable", "replayed": False}
        if not provider_available(requested_provider if b2b else None, controlled_test_allowed=b2b
                                  and requested_provider == "test"):
            await _set_status(connection, job["tenant_id"], analysis_id, attempt, "unavailable",
                              "AnalysisProviderUnavailable")
            return {"status": "unavailable", "replayed": False}

        try:
            if b2b:
                async with connection.transaction():
                    await connection.execute("SELECT set_config('app.tenant_id', %s, true)",
                                             (job["tenant_id"],))
                    if not await _b2b_rights_current(connection, job, analysis_id, attempt):
                        raise PermissionError("ExternalAIRightsUnavailable")
                    # The source lock spans the call: revocation cannot take effect between
                    # this final rights check and the start of an external request.
                    result = validate_extraction(body, await extract_review(
                        body, provider_override=requested_provider, model_override=requested_model,
                        max_output_tokens=tokens, max_retries=0, controlled_test_allowed=True))
            else:
                result = validate_extraction(body, await extract_review(body))
        except PermissionError:
            await _set_status(connection, job["tenant_id"], analysis_id, attempt, "unavailable",
                              "ExternalAIRightsUnavailable")
            return {"status": "unavailable", "replayed": False}
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
            if b2b and not await _b2b_rights_current(connection, job, analysis_id, attempt):
                await connection.execute(
                    "UPDATE marketrift.document_analyses SET status = 'unavailable', "
                    "last_error = 'ExternalAIRightsUnavailable', completed_at = now() "
                    "WHERE tenant_id = %s AND id = %s", (job["tenant_id"], analysis_id))
                return {"status": "unavailable", "replayed": False}
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
