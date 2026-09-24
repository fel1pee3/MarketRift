"""Steam review storage, replay and tenant isolation in migrated PostgreSQL."""

import asyncio
import os
from uuid import uuid4

import httpx
import psycopg
import pytest

from marketrift_intelligence.steam_reviews import SteamCollectionError, sync_steam_reviews

pytestmark = pytest.mark.skipif(
    not (os.getenv("TEST_DATABASE_ADMIN_URL") and os.getenv("RUNTIME_DATABASE_URL")),
    reason="requires migrated PostgreSQL",
)


def invoke(job, responder):
    async def work():
        async with httpx.AsyncClient(transport=httpx.MockTransport(responder)) as client:
            return await sync_steam_reviews(job, client)

    if os.name == "nt":
        return asyncio.run(work(), loop_factory=asyncio.SelectorEventLoop)
    return asyncio.run(work())


def steam_review(body="Good controls", updated=1780000000):
    return {"recommendationid": "901001", "review": body, "language": "english",
            "timestamp_created": 1779000000, "timestamp_updated": updated, "voted_up": True,
            "author": {"steamid": "not-stored", "num_games_owned": 999}}


def test_steam_replay_update_and_two_tenants(request):
    a, b = str(uuid4()), str(uuid4())
    source_a, source_b = str(uuid4()), str(uuid4())
    run_a1, run_a2, run_a3, run_b = [str(uuid4()) for _ in range(4)]

    def cleanup():
        with psycopg.connect(os.environ["TEST_DATABASE_ADMIN_URL"]) as admin:
            for table in ("insights", "document_analyses", "source_runs", "documents", "sources", "products"):
                admin.execute(f"DELETE FROM marketrift.{table} WHERE tenant_id IN (%s, %s)", (a, b))
            admin.execute("DELETE FROM marketrift.tenants WHERE id IN (%s, %s)", (a, b))

    request.addfinalizer(cleanup)
    with psycopg.connect(os.environ["TEST_DATABASE_ADMIN_URL"]) as admin:
        for tenant, source in ((a, source_a), (b, source_b)):
            product = str(uuid4())
            admin.execute("INSERT INTO marketrift.tenants (id, name) VALUES (%s, 'steam-test')", (tenant,))
            admin.execute("INSERT INTO marketrift.products (id, tenant_id, name, kind) "
                          "VALUES (%s, %s, 'Game', 'competitor')", (product, tenant))
            admin.execute("INSERT INTO marketrift.sources (id, tenant_id, product_id, source_type, url) "
                          "VALUES (%s, %s, %s, 'steam_reviews', 'https://store.steampowered.com/app/620/')",
                          (source, tenant, product))
        for tenant, source, run_id in ((a, source_a, run_a1), (b, source_b, run_b)):
            admin.execute("INSERT INTO marketrift.source_runs "
                          "(id, tenant_id, source_id, status, max_pages, max_items) "
                          "VALUES (%s, %s, %s, 'pending', 1, 5)", (run_id, tenant, source))

    def job(tenant, source, run_id):
        return {"version": 1, "tenant_id": tenant, "source_id": source, "run_id": run_id,
                "idempotency_key": f"steam-reviews-{run_id}-v1"}

    calls = []

    def first(request):
        calls.append(request)
        return httpx.Response(200, json={"success": 1, "cursor": "next", "reviews": [steam_review()]})

    with pytest.raises(SteamCollectionError, match="source_product_or_run_not_in_tenant"):
        invoke(job(a, source_b, run_b), first)
    assert not calls
    assert invoke(job(a, source_a, run_a1), first) == {
        "status": "succeeded", "received": 1, "new": 1, "updated": 0, "ignored": 0,
        "scan_complete": False,
    }
    assert invoke(job(a, source_a, run_a1), first)["replayed"] is True
    assert len(calls) == 1
    with psycopg.connect(os.environ["TEST_DATABASE_ADMIN_URL"]) as admin:
        document = admin.execute("SELECT id, body, steam_app_id, review_language, review_voted_up, synthetic, "
                                 "source_url_kind FROM marketrift.documents WHERE tenant_id = %s", (a,)).fetchone()
        assert document[1:] == ("Good controls", 620, "english", True, False, "product_reviews")
        assert admin.execute("SELECT count(*) FROM marketrift.document_analyses "
                             "WHERE tenant_id = %s", (a,)).fetchone()[0] == 0
        admin.execute("INSERT INTO marketrift.source_runs "
                      "(id, tenant_id, source_id, status, cursor_before, max_pages, max_items) "
                      "SELECT %s, tenant_id, source_id, 'pending', cursor_after, 1, 5 "
                      "FROM marketrift.source_runs WHERE id = %s", (run_a2, run_a1))
    repeated = invoke(job(a, source_a, run_a2), first)
    assert (repeated["new"], repeated["updated"]) == (0, 0)
    with psycopg.connect(os.environ["TEST_DATABASE_ADMIN_URL"]) as admin:
        assert admin.execute("SELECT count(*) FROM marketrift.documents WHERE tenant_id = %s", (a,)).fetchone()[0] == 1
        admin.execute("INSERT INTO marketrift.document_analyses "
                      "(tenant_id, document_id, extractor_version, status) "
                      "VALUES (%s, %s, 'review-issues-v1', 'completed')", (a, document[0]))
        admin.execute("INSERT INTO marketrift.source_runs "
                      "(id, tenant_id, source_id, status, cursor_before, max_pages, max_items) "
                      "SELECT %s, tenant_id, source_id, 'pending', cursor_after, 1, 5 "
                      "FROM marketrift.source_runs WHERE id = %s", (run_a3, run_a2))
    changed = lambda _request: httpx.Response(200, json={"success": 1, "cursor": "next", "reviews": [
        steam_review("Updated controls", 1780003600)]})
    assert invoke(job(a, source_a, run_a3), changed)["updated"] == 1
    with psycopg.connect(os.environ["TEST_DATABASE_ADMIN_URL"]) as admin:
        assert admin.execute("SELECT id, body FROM marketrift.documents "
                             "WHERE tenant_id = %s", (a,)).fetchone() == (document[0], "Updated controls")
        assert admin.execute("SELECT status FROM marketrift.document_analyses "
                             "WHERE tenant_id = %s", (a,)).fetchone()[0] == "pending"
    with psycopg.connect(os.environ["RUNTIME_DATABASE_URL"]) as runtime:
        runtime.execute("SELECT set_config('app.tenant_id', %s, true)", (b,))
        assert runtime.execute("SELECT count(*) FROM marketrift.documents WHERE tenant_id = %s", (a,)).fetchone()[0] == 0
        assert runtime.execute("UPDATE marketrift.documents SET body = 'wrong' "
                               "WHERE tenant_id = %s", (a,)).rowcount == 0
    assert invoke(job(b, source_b, run_b), first)["new"] == 1
    with psycopg.connect(os.environ["TEST_DATABASE_ADMIN_URL"]) as admin:
        assert admin.execute("SELECT count(*) FROM marketrift.documents "
                             "WHERE document_type = 'steam_review' AND external_key = '901001' "
                             "AND tenant_id IN (%s, %s)", (a, b)).fetchone()[0] == 2


def test_rate_limit_marks_run_failed_without_partial_documents(request):
    tenant, product, source, run_id = [str(uuid4()) for _ in range(4)]

    def cleanup():
        with psycopg.connect(os.environ["TEST_DATABASE_ADMIN_URL"]) as admin:
            for table in ("source_runs", "documents", "sources", "products"):
                admin.execute(f"DELETE FROM marketrift.{table} WHERE tenant_id = %s", (tenant,))
            admin.execute("DELETE FROM marketrift.tenants WHERE id = %s", (tenant,))

    request.addfinalizer(cleanup)
    with psycopg.connect(os.environ["TEST_DATABASE_ADMIN_URL"]) as admin:
        admin.execute("INSERT INTO marketrift.tenants (id, name) VALUES (%s, 'rate-test')", (tenant,))
        admin.execute("INSERT INTO marketrift.products (id, tenant_id, name, kind) "
                      "VALUES (%s, %s, 'Game', 'competitor')", (product, tenant))
        admin.execute("INSERT INTO marketrift.sources (id, tenant_id, product_id, source_type, url) "
                      "VALUES (%s, %s, %s, 'steam_reviews', 'https://store.steampowered.com/app/620/')",
                      (source, tenant, product))
        admin.execute("INSERT INTO marketrift.source_runs "
                      "(id, tenant_id, source_id, status, max_pages, max_items) "
                      "VALUES (%s, %s, %s, 'pending', 1, 2)", (run_id, tenant, source))

    job = {"version": 1, "tenant_id": tenant, "source_id": source,
           "run_id": run_id, "idempotency_key": f"steam-reviews-{run_id}-v1"}
    result = invoke(job, lambda _request: httpx.Response(429, headers={"Retry-After": "15"}))
    assert result == {"status": "failed", "error_code": "rate_limited"}
    with psycopg.connect(os.environ["TEST_DATABASE_ADMIN_URL"]) as admin:
        row = admin.execute("SELECT status, error_code, retry_after_at > now() "
                            "FROM marketrift.source_runs WHERE id = %s", (run_id,)).fetchone()
        assert row == ("failed", "rate_limited", True)
        assert admin.execute("SELECT count(*) FROM marketrift.documents WHERE tenant_id = %s",
                             (tenant,)).fetchone()[0] == 0
