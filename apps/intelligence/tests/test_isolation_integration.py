"""Runs against a disposable, migrated pgvector database when test URLs are set."""

import asyncio
import os
from uuid import uuid4

import psycopg
import pytest

from marketrift_intelligence.ingest import ingest

pytestmark = pytest.mark.skipif(
    not (os.getenv("TEST_DATABASE_ADMIN_URL") and os.getenv("RUNTIME_DATABASE_URL")),
    reason="requires disposable migrated PostgreSQL with pgvector",
)


def run_ingest(job: dict) -> dict:
    if os.name == "nt":
        return asyncio.run(ingest(job), loop_factory=asyncio.SelectorEventLoop)
    return asyncio.run(ingest(job))


def test_two_tenants_rls_and_repeated_jobs(request):
    tenant_a, tenant_b = str(uuid4()), str(uuid4())
    product_a, product_b = str(uuid4()), str(uuid4())
    source_a, source_b = str(uuid4()), str(uuid4())
    import_a, import_a_again = str(uuid4()), str(uuid4())

    def cleanup():
        with psycopg.connect(os.environ["TEST_DATABASE_ADMIN_URL"]) as admin:
            for table in ("import_rows", "documents", "imports", "sources", "products"):
                admin.execute(
                    f"DELETE FROM marketrift.{table} WHERE tenant_id IN (%s, %s)",
                    (tenant_a, tenant_b),
                )
            admin.execute("DELETE FROM marketrift.tenants WHERE id IN (%s, %s)", (tenant_a, tenant_b))

    request.addfinalizer(cleanup)
    with psycopg.connect(os.environ["TEST_DATABASE_ADMIN_URL"]) as admin:
        for tenant in (tenant_a, tenant_b):
            admin.execute(
                "INSERT INTO marketrift.tenants (id, name) VALUES (%s, %s)", (tenant, f"test-{tenant}")
            )
        for tenant, product, source in ((tenant_a, product_a, source_a), (tenant_b, product_b, source_b)):
            admin.execute(
                "INSERT INTO marketrift.products (id, tenant_id, name, kind) VALUES (%s, %s, %s, 'competitor')",
                (product, tenant, "Competitor"),
            )
            admin.execute(
                "INSERT INTO marketrift.sources (id, tenant_id, product_id, source_type, url) "
                "VALUES (%s, %s, %s, 'manual_review', 'https://example.invalid')",
                (source, tenant, product),
            )
        for imported in (import_a, import_a_again):
            admin.execute(
                "INSERT INTO marketrift.imports (id, tenant_id, source_id, idempotency_key, total_rows) "
                "VALUES (%s, %s, %s, %s, 1)",
                (imported, tenant_a, source_a, f"import-{imported}-v1"),
            )
            admin.execute(
                "INSERT INTO marketrift.import_rows "
                "(tenant_id, import_id, external_key, source_url, published_at, body, synthetic) "
                "VALUES (%s, %s, 'review-1', 'https://example.invalid/review-1', now(), 'Synthetic review', true)",
                (tenant_a, imported),
            )

    def job(imported: str, source: str) -> dict:
        return {
            "version": 1,
            "tenant_id": tenant_a,
            "source_id": source,
            "import_id": imported,
            "idempotency_key": f"import-{imported}-v1",
        }

    with pytest.raises(ValueError, match="source does not belong"):
        run_ingest(job(import_a, source_b))
    assert run_ingest(job(import_a, source_a))["new_documents"] == 1
    assert run_ingest(job(import_a, source_a))["new_documents"] == 0
    assert run_ingest(job(import_a_again, source_a))["new_documents"] == 0

    with psycopg.connect(os.environ["RUNTIME_DATABASE_URL"]) as runtime:
        runtime.execute("SELECT set_config('app.tenant_id', %s, true)", (tenant_a,))
        visible = runtime.execute("SELECT count(*) FROM marketrift.documents").fetchone()[0]
        assert visible == 1
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            runtime.execute(
                "INSERT INTO marketrift.documents "
                "(tenant_id, source_id, document_type, external_key, source_url, body) "
                "VALUES (%s, %s, 'review', 'forbidden', 'https://example.invalid', 'Wrong tenant')",
                (tenant_b, source_b),
            )
    with psycopg.connect(os.environ["RUNTIME_DATABASE_URL"]) as runtime:
        runtime.execute("SELECT set_config('app.tenant_id', %s, true)", (tenant_b,))
        assert runtime.execute("SELECT count(*) FROM marketrift.documents").fetchone()[0] == 0
