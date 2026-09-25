"""PostgreSQL/RLS integration with controlled GraphQL responses."""

import asyncio
import os
from uuid import uuid4

import httpx
import psycopg
import pytest
from test_github_discussions import discussion, envelope

from marketrift_intelligence.github_discussions import CollectionError, sync_github_discussions

pytestmark = pytest.mark.skipif(
    not (os.getenv("TEST_DATABASE_ADMIN_URL") and os.getenv("RUNTIME_DATABASE_URL")),
    reason="requires migrated PostgreSQL",
)


def invoke(job, handler):
    async def work():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            return await sync_github_discussions(job, client)
    return asyncio.run(work(), loop_factory=asyncio.SelectorEventLoop) if os.name == "nt" else asyncio.run(work())


def test_replay_update_isolation_and_missing_token(request, monkeypatch):
    tenant_a, tenant_b = str(uuid4()), str(uuid4())
    source_a, source_b = str(uuid4()), str(uuid4())
    product_a, product_b = str(uuid4()), str(uuid4())

    def cleanup():
        with psycopg.connect(os.environ["TEST_DATABASE_ADMIN_URL"]) as db:
            for table in ("source_runs", "documents", "sources", "products"):
                db.execute(f"DELETE FROM marketrift.{table} WHERE tenant_id IN (%s, %s)", (tenant_a, tenant_b))
            db.execute("DELETE FROM marketrift.tenants WHERE id IN (%s, %s)", (tenant_a, tenant_b))
    request.addfinalizer(cleanup)

    with psycopg.connect(os.environ["TEST_DATABASE_ADMIN_URL"]) as db:
        for tenant, product, source in ((tenant_a, product_a, source_a), (tenant_b, product_b, source_b)):
            db.execute("INSERT INTO marketrift.tenants (id, name) VALUES (%s, 'discussion-test')", (tenant,))
            db.execute("INSERT INTO marketrift.products (id, tenant_id, name, kind) "
                       "VALUES (%s, %s, 'Competitor', 'competitor')", (product, tenant))
            db.execute("INSERT INTO marketrift.sources (id, tenant_id, product_id, source_type, url) "
                       "VALUES (%s, %s, %s, 'github_discussions', 'https://github.com/example/repo')",
                       (source, tenant, product))

    def create_run(tenant, source):
        run_id = str(uuid4())
        with psycopg.connect(os.environ["TEST_DATABASE_ADMIN_URL"]) as db:
            db.execute("INSERT INTO marketrift.source_runs "
                       "(id, tenant_id, source_id, status, max_pages, max_items) "
                       "VALUES (%s, %s, %s, 'pending', 1, 5)", (run_id, tenant, source))
        return {"version": 1, "tenant_id": tenant, "source_id": source, "run_id": run_id,
                "idempotency_key": f"github-discussions-{run_id}-v1"}

    monkeypatch.setenv("GITHUB_DISCUSSIONS_TOKEN", "local-test-token")
    job_a = create_run(tenant_a, source_a)
    calls = []

    def initial(_request):
        calls.append(1)
        return httpx.Response(200, json=envelope([discussion()]))

    with pytest.raises(CollectionError, match="source_or_run_not_in_tenant"):
        invoke({**job_a, "source_id": source_b}, initial)
    assert not calls
    assert invoke(job_a, initial)["new"] == 1
    assert invoke(job_a, initial)["replayed"] is True
    assert len(calls) == 1
    job_repeat = create_run(tenant_a, source_a)
    assert invoke(job_repeat, initial)["new"] == 0
    job_edited = create_run(tenant_a, source_a)
    edited = lambda _request: httpx.Response(200, json=envelope([
        discussion(body="Edited product feedback with a reproducible bug.", updated="2026-09-24T13:00:00Z")]))
    assert invoke(job_edited, edited)["updated"] == 1
    with psycopg.connect(os.environ["TEST_DATABASE_ADMIN_URL"]) as db:
        assert db.execute("SELECT count(*), max(source_body), max(discussion_category) "
                          "FROM marketrift.documents WHERE tenant_id = %s", (tenant_a,)).fetchone() == (
            1, "Edited product feedback with a reproducible bug.", "Ideas")
        assert db.execute("SELECT count(*) FROM marketrift.document_analyses WHERE tenant_id = %s",
                          (tenant_a,)).fetchone()[0] == 0
    with psycopg.connect(os.environ["RUNTIME_DATABASE_URL"]) as db:
        db.execute("SELECT set_config('app.tenant_id', %s, true)", (tenant_b,))
        assert db.execute("SELECT count(*) FROM marketrift.documents WHERE tenant_id = %s",
                          (tenant_a,)).fetchone()[0] == 0
        assert db.execute("UPDATE marketrift.documents SET body = 'wrong' WHERE tenant_id = %s",
                          (tenant_a,)).rowcount == 0
    job_b = create_run(tenant_b, source_b)
    assert invoke(job_b, initial)["new"] == 1
    monkeypatch.delenv("GITHUB_DISCUSSIONS_TOKEN")
    no_token = create_run(tenant_a, source_a)
    assert invoke(no_token, lambda _request: pytest.fail("No network without token"))["error_code"] == "configuration_pending"
    with psycopg.connect(os.environ["TEST_DATABASE_ADMIN_URL"]) as db:
        assert db.execute("SELECT count(*) FROM marketrift.documents WHERE external_key = 'D_1' ").fetchone()[0] == 2
