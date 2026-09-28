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


def test_two_tenants_rls_and_repeated_jobs(request, monkeypatch):
    tenant_a, tenant_b = str(uuid4()), str(uuid4())
    product_a, product_b = str(uuid4()), str(uuid4())
    source_a, source_b = str(uuid4()), str(uuid4())
    import_a, import_a_again = str(uuid4()), str(uuid4())
    queued = []

    async def record_analysis_jobs(_tenant, document_ids):
        queued.extend(document_ids)

    monkeypatch.setattr("marketrift_intelligence.ingest.publish_analyses", record_analysis_jobs)

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
    assert len(set(queued)) == 1

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

    # Browser credentials and invitation hashes are outside the worker/runtime role.
    for private_table in ("browser_sessions", "member_invitations"):
        with psycopg.connect(os.environ["RUNTIME_DATABASE_URL"]) as runtime, pytest.raises(
            psycopg.errors.InsufficientPrivilege
        ):
            runtime.execute(f"SELECT count(*) FROM marketrift.{private_table}")


def test_old_b2b_import_job_cannot_restore_purged_synthetic_text_after_renewal(request):
    tenant, product, source, imported = (str(uuid4()) for _ in range(4))

    def cleanup():
        with psycopg.connect(os.environ["TEST_DATABASE_ADMIN_URL"]) as admin:
            for table in ("import_rows", "documents", "imports", "sources", "products"):
                admin.execute(f"DELETE FROM marketrift.{table} WHERE tenant_id = %s", (tenant,))
            admin.execute("DELETE FROM marketrift.tenants WHERE id = %s", (tenant,))

    request.addfinalizer(cleanup)
    with psycopg.connect(os.environ["TEST_DATABASE_ADMIN_URL"]) as admin:
        admin.execute("INSERT INTO marketrift.tenants (id,name) VALUES (%s,'b2b-old-job-test')", (tenant,))
        admin.execute("INSERT INTO marketrift.products (id,tenant_id,name,kind) "
                      "VALUES (%s,%s,'Disposable test','competitor')", (product, tenant))
        admin.execute("INSERT INTO marketrift.sources (id,tenant_id,product_id,source_type,url,"
                      "access_environment,rights_reference,rights_attested_at,storage_permitted) "
                      "VALUES (%s,%s,%s,'b2b_csv_review','https://example.invalid/b2b',"
                      "'sandbox','synthetic-test-rights',now(),true)", (source, tenant, product))
        admin.execute("INSERT INTO marketrift.imports "
                      "(id,tenant_id,source_id,idempotency_key,total_rows,b2b_rights_generation) "
                      "VALUES (%s,%s,%s,%s,1,1)", (imported, tenant, source, f"import-{imported}-v1"))
        admin.execute("INSERT INTO marketrift.import_rows "
                      "(tenant_id,import_id,external_key,source_url,published_at,body,synthetic) "
                      "VALUES (%s,%s,'synthetic-one','https://example.invalid/b2b/1',now(),"
                      "'Synthetic fixture: support delayed.',true)", (tenant, imported))
    job = {"version": 1, "tenant_id": tenant, "source_id": source,
           "import_id": imported, "idempotency_key": f"import-{imported}-v1"}
    assert run_ingest(job)["new_documents"] == 1
    with psycopg.connect(os.environ["TEST_DATABASE_ADMIN_URL"]) as admin:
        admin.execute("DELETE FROM marketrift.import_rows WHERE import_id=%s", (imported,))
        admin.execute("DELETE FROM marketrift.documents WHERE source_id=%s", (source,))
        admin.execute("UPDATE marketrift.sources SET b2b_rights_generation=2 WHERE id=%s", (source,))
    with pytest.raises(ValueError, match="b2b_import_rights_generation_changed"):
        run_ingest(job)
    with psycopg.connect(os.environ["TEST_DATABASE_ADMIN_URL"]) as admin:
        assert admin.execute("SELECT count(*) FROM marketrift.documents WHERE source_id=%s",
                             (source,)).fetchone()[0] == 0
