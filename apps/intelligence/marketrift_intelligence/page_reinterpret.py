"""Reassess stored structural markup without fetching a page or creating a snapshot."""

import json
import os
from pathlib import Path

import psycopg
from jsonschema import Draft202012Validator, FormatChecker

from .web_pages import EXTRACTOR_VERSION, PageError, page_content

SCHEMA = json.loads((Path(__file__).resolve().parents[3] /
                     "packages/contracts/reinterpret-web-page-job.v1.schema.json").read_text(encoding="utf-8"))
VALIDATOR = Draft202012Validator(SCHEMA, format_checker=FormatChecker())


def validate_job(payload: object) -> dict:
    VALIDATOR.validate(payload)
    assert isinstance(payload, dict)
    if payload["idempotency_key"] != f"page-reinterpret-{payload['interpretation_id']}-v1":
        raise PageError("invalid_job_key")
    if payload["rule_version"] != EXTRACTOR_VERSION:
        raise PageError("rule_version_mismatch")
    return payload


async def reinterpret_snapshot(payload: object) -> dict:
    job = validate_job(payload)
    async with await psycopg.AsyncConnection.connect(os.environ["RUNTIME_DATABASE_URL"]) as connection:
        await connection.execute("SELECT set_config('app.tenant_id', %s, true)", (job["tenant_id"],))
        row = await (await connection.execute(
            "SELECT i.status,i.basis,ss.reparse_markup,ss.capture_complete,ss.normalized_text,"
            "ss.final_url,s.source_type FROM marketrift.snapshot_interpretations i "
            "JOIN marketrift.source_snapshots ss ON ss.tenant_id=i.tenant_id AND ss.id=i.snapshot_id "
            "JOIN marketrift.sources s ON s.tenant_id=ss.tenant_id AND s.id=ss.source_id "
            "WHERE i.tenant_id=%s AND i.id=%s AND i.snapshot_id=%s AND i.source_id=%s "
            "AND i.rule_version=%s AND s.enabled AND s.source_type IN ('release_notes','pricing_page') "
            "FOR UPDATE OF i", (job["tenant_id"], job["interpretation_id"], job["snapshot_id"],
                                job["source_id"], job["rule_version"]))).fetchone()
        if row is None:
            raise PageError("interpretation_not_in_tenant")
        if row[0] == "completed":
            return {"status": "completed", "replayed": True}
        if row[0] != "pending":
            return {"status": row[0], "replayed": True}
        if not row[2]:
            await connection.execute(
                "UPDATE marketrift.snapshot_interpretations SET status='blocked',"
                "reason='historical_markup_unavailable',finished_at=now() WHERE tenant_id=%s AND id=%s",
                (job["tenant_id"], job["interpretation_id"]))
            return {"status": "blocked", "reason": "historical_markup_unavailable"}
        await connection.execute(
            "UPDATE marketrift.snapshot_interpretations SET status='running',reason='processing' "
            "WHERE tenant_id=%s AND id=%s", (job["tenant_id"], job["interpretation_id"]))
    try:
        content = page_content(row[2], row[6], row[5], complete=row[3])
        if content["text"] != row[4]:
            raise PageError("historical_markup_text_mismatch")
        async with await psycopg.AsyncConnection.connect(os.environ["RUNTIME_DATABASE_URL"]) as connection:
            await connection.execute("SELECT set_config('app.tenant_id', %s, true)", (job["tenant_id"],))
            locked = await (await connection.execute(
                "SELECT i.status,ss.reparse_markup FROM marketrift.snapshot_interpretations i "
                "JOIN marketrift.source_snapshots ss ON ss.tenant_id=i.tenant_id AND ss.id=i.snapshot_id "
                "WHERE i.tenant_id=%s AND i.id=%s AND i.snapshot_id=%s AND i.source_id=%s "
                "FOR UPDATE OF i,ss", (job["tenant_id"], job["interpretation_id"],
                                       job["snapshot_id"], job["source_id"]))).fetchone()
            if locked is None or locked[0] != "running" or locked[1] != row[2]:
                raise PageError("interpretation_state_changed")
            await connection.execute(
                "UPDATE marketrift.source_snapshots SET extracted=%s::jsonb,interpretation_version=%s,"
                "interpretation_status=%s,interpretation_reason=%s WHERE tenant_id=%s AND id=%s",
                (json.dumps(content, ensure_ascii=False), EXTRACTOR_VERSION, content["status"], content["reason"],
                 job["tenant_id"], job["snapshot_id"]))
            await connection.execute(
                "UPDATE marketrift.snapshot_interpretations SET status='completed',"
                "interpretation_status=%s,reason=%s,extracted=%s::jsonb,finished_at=now() "
                "WHERE tenant_id=%s AND id=%s",
                (content["status"], content["reason"], json.dumps(content, ensure_ascii=False),
                 job["tenant_id"], job["interpretation_id"]))
            await connection.execute(
                "INSERT INTO marketrift.signal_reconcile_sources (tenant_id,source_id) VALUES (%s,%s) "
                "ON CONFLICT (tenant_id,source_id) DO UPDATE SET "
                "requested_revision=signal_reconcile_sources.requested_revision+1,"
                "next_attempt_at=now(),last_error=NULL,attempts=0,updated_at=now()",
                (job["tenant_id"], job["source_id"]))
        return {"status": "completed", "reason": content["reason"]}
    except PageError as error:
        async with await psycopg.AsyncConnection.connect(os.environ["RUNTIME_DATABASE_URL"]) as connection:
            await connection.execute("SELECT set_config('app.tenant_id', %s, true)", (job["tenant_id"],))
            await connection.execute(
                "UPDATE marketrift.snapshot_interpretations SET status='blocked',reason=%s,finished_at=now() "
                "WHERE tenant_id=%s AND id=%s AND status='running'",
                (error.code, job["tenant_id"], job["interpretation_id"]))
        return {"status": "blocked", "reason": error.code}
    except Exception:
        # The queue retries transient failures; leave the durable row retryable too.
        async with await psycopg.AsyncConnection.connect(os.environ["RUNTIME_DATABASE_URL"]) as connection:
            await connection.execute("SELECT set_config('app.tenant_id', %s, true)", (job["tenant_id"],))
            await connection.execute(
                "UPDATE marketrift.snapshot_interpretations SET status='pending',reason='retry_pending' "
                "WHERE tenant_id=%s AND id=%s AND status='running'",
                (job["tenant_id"], job["interpretation_id"]))
        raise
