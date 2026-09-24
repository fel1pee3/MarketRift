"""Migrated PostgreSQL/RLS integration, with GitHub API fully mocked."""

import asyncio
import os
from uuid import uuid4

import httpx
import psycopg
import pytest

from marketrift_intelligence.github_issues import CollectionError, sync_github_issues

pytestmark = pytest.mark.skipif(
    not (os.getenv("TEST_DATABASE_ADMIN_URL") and os.getenv("RUNTIME_DATABASE_URL")),
    reason="requires migrated PostgreSQL",
)


def invoke(job, response):
    async def work():
        async with httpx.AsyncClient(transport=httpx.MockTransport(response)) as client:
            return await sync_github_issues(job, client)

    if os.name == "nt":
        return asyncio.run(work(), loop_factory=asyncio.SelectorEventLoop)
    return asyncio.run(work())


def issue(body="Initial bug", updated="2026-09-24T12:00:00Z"):
    return {"id": 901, "number": 7, "html_url": "https://github.com/example/repo/issues/7",
            "title": "Bug report", "body": body, "created_at": "2026-09-01T10:00:00Z",
            "updated_at": updated, "state": "open"}


def test_two_tenants_replay_dedup_and_update(request):
    a, b = str(uuid4()), str(uuid4())
    source_a, source_b = str(uuid4()), str(uuid4())
    run_a1, run_a2, run_a3, run_b = [str(uuid4()) for _ in range(4)]

    def cleanup():
        with psycopg.connect(os.environ["TEST_DATABASE_ADMIN_URL"]) as admin:
            for table in ("source_runs", "documents", "sources", "products"):
                admin.execute(f"DELETE FROM marketrift.{table} WHERE tenant_id IN (%s, %s)", (a, b))
            admin.execute("DELETE FROM marketrift.tenants WHERE id IN (%s, %s)", (a, b))

    request.addfinalizer(cleanup)
    with psycopg.connect(os.environ["TEST_DATABASE_ADMIN_URL"]) as admin:
        for tenant, source in ((a, source_a), (b, source_b)):
            product = str(uuid4())
            admin.execute("INSERT INTO marketrift.tenants (id, name) VALUES (%s, 'github-test')", (tenant,))
            admin.execute("INSERT INTO marketrift.products (id, tenant_id, name, kind) "
                          "VALUES (%s, %s, 'Competitor', 'competitor')", (product, tenant))
            admin.execute("INSERT INTO marketrift.sources (id, tenant_id, product_id, source_type, url) "
                          "VALUES (%s, %s, %s, 'github_issues', 'https://github.com/example/repo')",
                          (source, tenant, product))
        for tenant, source, run_id in ((a, source_a, run_a1), (a, source_a, run_a2),
                                       (a, source_a, run_a3), (b, source_b, run_b)):
            # Only the first run per source can remain pending because of the active-run index.
            if run_id in (run_a2, run_a3):
                continue
            admin.execute("INSERT INTO marketrift.source_runs "
                          "(id, tenant_id, source_id, status, max_pages, max_items) "
                          "VALUES (%s, %s, %s, 'pending', 1, 5)", (run_id, tenant, source))

    def job(tenant, source, run_id):
        return {"version": 1, "tenant_id": tenant, "source_id": source, "run_id": run_id,
                "idempotency_key": f"github-issues-{run_id}-v1"}

    calls = []

    def first(request):
        calls.append(request)
        return httpx.Response(200, json=[issue()])

    with pytest.raises(CollectionError, match="source_or_run_not_in_tenant"):
        invoke(job(a, source_b, run_b), first)
    assert not calls
    assert invoke(job(a, source_a, run_a1), first)["new"] == 1
    assert invoke(job(a, source_a, run_a1), first)["replayed"] is True
    assert len(calls) == 1

    with psycopg.connect(os.environ["TEST_DATABASE_ADMIN_URL"]) as admin:
        admin.execute("INSERT INTO marketrift.source_runs "
                      "(id, tenant_id, source_id, status, cursor_before, max_pages, max_items) "
                      "SELECT %s, tenant_id, source_id, 'pending', cursor_after, 1, 5 "
                      "FROM marketrift.source_runs WHERE id = %s", (run_a2, run_a1))
    assert invoke(job(a, source_a, run_a2), first) == {
        "status": "succeeded", "seen": 1, "new": 0, "updated": 0,
    }

    with psycopg.connect(os.environ["TEST_DATABASE_ADMIN_URL"]) as admin:
        admin.execute("INSERT INTO marketrift.source_runs "
                      "(id, tenant_id, source_id, status, cursor_before, max_pages, max_items) "
                      "SELECT %s, tenant_id, source_id, 'pending', cursor_after, 1, 5 "
                      "FROM marketrift.source_runs WHERE id = %s", (run_a3, run_a2))
    updated = lambda _request: httpx.Response(200, json=[issue("Updated bug", "2026-09-24T13:00:00Z")])
    assert invoke(job(a, source_a, run_a3), updated)["updated"] == 1

    with psycopg.connect(os.environ["TEST_DATABASE_ADMIN_URL"]) as admin:
        assert admin.execute("SELECT count(*), max(source_body), max(source_repository) "
                             "FROM marketrift.documents WHERE tenant_id = %s", (a,)).fetchone() == (
            1, "Updated bug", "example/repo")
        assert admin.execute("SELECT count(*) FROM marketrift.document_analyses "
                             "WHERE tenant_id = %s", (a,)).fetchone()[0] == 0

    with psycopg.connect(os.environ["RUNTIME_DATABASE_URL"]) as runtime:
        runtime.execute("SELECT set_config('app.tenant_id', %s, true)", (b,))
        assert runtime.execute("SELECT count(*) FROM marketrift.documents WHERE tenant_id = %s", (a,)).fetchone()[0] == 0
        assert runtime.execute("UPDATE marketrift.documents SET body = 'wrong' "
                               "WHERE tenant_id = %s", (a,)).rowcount == 0
    assert invoke(job(b, source_b, run_b), first)["new"] == 1
    with psycopg.connect(os.environ["TEST_DATABASE_ADMIN_URL"]) as admin:
        assert admin.execute("SELECT count(*) FROM marketrift.documents "
                             "WHERE external_key = '901'").fetchone()[0] == 2
