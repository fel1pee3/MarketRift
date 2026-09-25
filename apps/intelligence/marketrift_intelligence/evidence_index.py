"""Reconcile a tenant source into pgvector without exporting text to a provider."""
import hashlib
import os
from typing import Any
from uuid import UUID

import psycopg
from pydantic import BaseModel, ConfigDict, Field, field_validator

from .embeddings import DIMENSIONS, embed, identity


class IndexJob(BaseModel):
    model_config = ConfigDict(extra="forbid")
    contract_version: str
    tenant_id: str
    source_id: str
    idempotency_key: str = Field(min_length=8, max_length=150)

    @field_validator('tenant_id', 'source_id')
    @classmethod
    def valid_uuid(cls, value: str) -> str:
        UUID(value)
        return value


def chunks(text: str) -> list[str]:
    clean = text.strip()
    if not clean:
        return []
    result = []
    start = 0
    while start < len(clean):
        if len(result) >= 100:
            raise ValueError("content_chunk_limit_exceeded")
        end = min(start + 480, len(clean))
        if end < len(clean):
            boundary = clean.rfind(" ", start + 300, end)
            if boundary > start:
                end = boundary
        result.append(clean[start:end])
        if end == len(clean):
            break
        start = max(start + 1, end - 60)
    return result


def eligible_document(row: tuple[Any, ...]) -> bool:
    (_, document_type, _, synthetic, data_status, enabled, source_type, storage,
     reference, expires, environment) = row
    if not enabled or document_type == "g2_review":
        return False
    if document_type in ("github_issue", "github_discussion"):
        return source_type in ("github_issues", "github_discussions")
    if document_type == "b2b_review":
        if source_type != "b2b_csv_review" or not storage or not reference:
            return False
        if synthetic:
            return data_status == "synthetic_fixture"
        from datetime import UTC, datetime
        return data_status == "declared_real" and environment == "production" and (
            expires is None or expires > datetime.now(UTC))
    if document_type == "review":
        return bool(synthetic and data_status == "synthetic_fixture")
    # Steam source rights for local processing have not been confirmed.
    return False


async def index_source(payload: object) -> dict[str, int]:
    job = IndexJob.model_validate(payload)
    if job.contract_version != "index-evidence.v1":
        raise ValueError("unsupported_contract_version")
    model, version = identity()
    desired: dict[tuple[str, str, int], tuple[str, str, str, bool, str, str]] = {}
    async with await psycopg.AsyncConnection.connect(os.environ["RUNTIME_DATABASE_URL"]) as connection:  # noqa: SIM117 - explicit tenant transaction
        async with connection.transaction():
            await connection.execute("SELECT set_config('app.tenant_id', %s, true)", (job.tenant_id,))
            source = await (await connection.execute(
                "SELECT product_id, source_type FROM marketrift.sources WHERE tenant_id = %s AND id = %s FOR UPDATE",
                (job.tenant_id, job.source_id))).fetchone()
            if not source:
                raise ValueError("source_not_in_tenant")
            rows = await (await connection.execute(
                "SELECT d.id, d.document_type, d.body, d.synthetic, d.review_data_status, "
                "s.enabled, s.source_type, s.storage_permitted, s.rights_reference, "
                "s.rights_expires_at, s.access_environment FROM marketrift.documents d "
                "JOIN marketrift.sources s ON s.tenant_id = d.tenant_id AND s.id = d.source_id "
                "WHERE d.tenant_id = %s AND d.source_id = %s ORDER BY d.id LIMIT 1001",
                (job.tenant_id, job.source_id))).fetchall()
            if len(rows) > 1000:
                raise ValueError("source_index_limit_exceeded")
            for row in rows:
                if not eligible_document(row):
                    continue
                for number, excerpt in enumerate(chunks(row[2])):
                    desired[("document", str(row[0]), number)] = (
                        excerpt, hashlib.sha256(excerpt.encode()).hexdigest(), hashlib.md5(row[2].encode()).hexdigest(), bool(row[3]),
                        row[1], str(source[0]))
            if source[1] in ("pricing_page", "release_notes"):
                pages = await (await connection.execute(
                    "SELECT ss.id, ss.normalized_text FROM marketrift.source_snapshots ss "
                    "JOIN marketrift.sources s ON s.tenant_id = ss.tenant_id AND s.id = ss.source_id "
                    "WHERE ss.tenant_id = %s AND ss.source_id = %s AND s.enabled "
                    "AND ss.interpretation_version >= 2 AND ss.interpretation_status = 'confirmed' "
                    "ORDER BY ss.fetched_at DESC LIMIT 101", (job.tenant_id, job.source_id))).fetchall()
                if len(pages) > 100:
                    raise ValueError("snapshot_index_limit_exceeded")
                for page_id, body in pages:
                    for number, excerpt in enumerate(chunks(body or "")):
                        desired[("snapshot", str(page_id), number)] = (
                            excerpt, hashlib.sha256(excerpt.encode()).hexdigest(), hashlib.md5((body or "").encode()).hexdigest(), False,
                            source[1], str(source[0]))
            existing = await (await connection.execute(
                "SELECT id, document_id, snapshot_id, chunk_no, content_sha256, content_version, embedding_model, "
                "embedding_version FROM marketrift.evidence_chunks WHERE tenant_id = %s AND source_id = %s FOR UPDATE",
                (job.tenant_id, job.source_id))).fetchall()
            indexed = removed = 0
            unchanged: set[tuple[str, str, int]] = set()
            for chunk_id, document_id, snapshot_id, number, digest, old_content_version, old_model, old_version in existing:
                key = ("document", str(document_id), number) if document_id else ("snapshot", str(snapshot_id), number)
                target = desired.get(key)
                if target and target[1] == digest and target[2] == old_content_version and old_model == model and old_version == version:
                    unchanged.add(key)
                    continue
                await connection.execute("DELETE FROM marketrift.evidence_chunks WHERE tenant_id = %s AND id = %s",
                                         (job.tenant_id, chunk_id))
                removed += 1
            for (kind, item_id, number), (text, digest, content_version, synthetic, source_type, product_id) in desired.items():
                if (kind, item_id, number) in unchanged:
                    continue
                vector = "[" + ",".join(str(value) for value in embed(text)) + "]"
                await connection.execute(
                    "INSERT INTO marketrift.evidence_chunks (tenant_id, source_id, product_id, document_id, "
                    "snapshot_id, source_type, chunk_no, content_version, text_content, content_sha256, "
                    "embedding_model, embedding_version, embedding_dimensions, synthetic, embedding) "
                    "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s::vector)",
                    (job.tenant_id, job.source_id, product_id, item_id if kind == "document" else None,
                     item_id if kind == "snapshot" else None, source_type, number, content_version, text, digest,
                    model, version, DIMENSIONS, synthetic, vector))
                indexed += 1
    return {"indexed": indexed, "removed": removed, "unchanged": len(unchanged)}
