"""Disposable two-tenant pgvector/RLS fixtures; no provider calls."""
import asyncio
import os
from uuid import uuid4

import psycopg
import pytest

from marketrift_intelligence import evidence_index
from marketrift_intelligence.evidence_index import index_source

pytestmark = pytest.mark.skipif(
    not (os.getenv("TEST_DATABASE_ADMIN_URL") and os.getenv("RUNTIME_DATABASE_URL")),
    reason="requires migrated PostgreSQL",
)


def run(payload):
    if os.name == "nt":
        return asyncio.run(index_source(payload), loop_factory=asyncio.SelectorEventLoop)
    return asyncio.run(index_source(payload))


def test_index_source_checks_tenant_and_rls(request, monkeypatch):
    monkeypatch.setenv("EMBEDDING_PROVIDER", "controlled")
    monkeypatch.setattr(evidence_index, "MAX_CHUNKS_PER_JOB", 1)
    tenant_a, tenant_b = str(uuid4()), str(uuid4())
    source_a = str(uuid4())

    def cleanup():
        with psycopg.connect(os.environ["TEST_DATABASE_ADMIN_URL"]) as db:
            for table in ("evidence_chunks", "documents", "sources", "products"):
                db.execute(f"DELETE FROM marketrift.{table} WHERE tenant_id IN (%s, %s)",
                           (tenant_a, tenant_b))
            db.execute("DELETE FROM marketrift.tenants WHERE id IN (%s, %s)", (tenant_a, tenant_b))

    request.addfinalizer(cleanup)
    with psycopg.connect(os.environ["TEST_DATABASE_ADMIN_URL"]) as db:
        for tenant, source in ((tenant_a, source_a), (tenant_b, str(uuid4()))):
            product, document = str(uuid4()), str(uuid4())
            db.execute("INSERT INTO marketrift.tenants (id, name) VALUES (%s, 'index-test')", (tenant,))
            db.execute("INSERT INTO marketrift.products (id, tenant_id, name, kind) "
                       "VALUES (%s, %s, 'index-test', 'competitor')", (product, tenant))
            db.execute("INSERT INTO marketrift.sources (id, tenant_id, product_id, source_type, url, "
                       "access_environment, rights_reference, storage_permitted) "
                       "VALUES (%s, %s, %s, 'b2b_csv_review', %s, 'sandbox', 'test-rights', true)",
                       (source, tenant, product, f"https://example.invalid/{tenant}"))
            db.execute("INSERT INTO marketrift.documents (id, tenant_id, source_id, document_type, "
                       "external_key, source_url, body, synthetic, review_data_status) "
                       "VALUES (%s, %s, %s, 'b2b_review', 'one', %s, %s, true, "
                       "'synthetic_fixture')", (document, tenant, source, f"https://example.invalid/{tenant}/1",
                                               "Synthetic support delay. " * 30))
    job = {"contract_version": "index-evidence.v1", "tenant_id": tenant_a,
           "source_id": source_a, "idempotency_key": "index-integration-test"}
    first = run(job)
    assert first["indexed"] == 1 and first["remaining"] > 0
    resumed = run(job)
    assert resumed["indexed"] == 1 and resumed["remaining"] == 0
    assert run(job)["unchanged"] == 2
    with pytest.raises(ValueError, match="source_not_in_tenant"):
        run({**job, "tenant_id": tenant_b})
    with psycopg.connect(os.environ["RUNTIME_DATABASE_URL"]) as db:
        db.execute("SELECT set_config('app.tenant_id', %s, true)", (tenant_b,))
        assert db.execute("SELECT count(*) FROM marketrift.evidence_chunks").fetchone()[0] == 0
        db.commit()
        db.execute("SELECT set_config('app.tenant_id', %s, true)", (tenant_a,))
        assert db.execute("SELECT count(*) FROM marketrift.evidence_chunks").fetchone()[0] == 2

    # A new model gets its own rows; the old controlled vectors are never used as local vectors.
    monkeypatch.setattr(evidence_index, "identity", lambda: ("local-test-model", "fixed-revision"))
    monkeypatch.setattr(evidence_index, "embed", lambda _: [1.0] + [0.0] * 383)
    assert run(job)["remaining"] == 1
    assert run(job)["remaining"] == 0
    with psycopg.connect(os.environ["TEST_DATABASE_ADMIN_URL"]) as db:
        assert db.execute("SELECT count(DISTINCT embedding_model) FROM marketrift.evidence_chunks "
                          "WHERE tenant_id = %s", (tenant_a,)).fetchone()[0] == 2
        db.execute("UPDATE marketrift.sources SET storage_permitted = false WHERE id = %s", (source_a,))
    assert run(job)["removed"] == 4
