"""Page snapshot persistence, replay, failure and tenant isolation in migrated PostgreSQL."""

import asyncio
import os
from uuid import uuid4

import psycopg
import pytest

from marketrift_intelligence.web_pages import PageError, check_web_page

pytestmark = pytest.mark.skipif(
    not (os.getenv("TEST_DATABASE_ADMIN_URL") and os.getenv("RUNTIME_DATABASE_URL")),
    reason="requires migrated PostgreSQL",
)


def invoke(job, html):
    async def work():
        return await check_web_page(job, lambda url, last_checked_at=None: (url, html))

    if os.name == "nt":
        return asyncio.run(work(), loop_factory=asyncio.SelectorEventLoop)
    return asyncio.run(work())


def markup(amount):
    return f"<main><section class='plan'><h2>Pro</h2><p>USD {amount} per month</p><p>API access</p></section></main>"


def test_two_tenants_snapshots_changes_replay_and_unextractable(request):
    tenants = [str(uuid4()) for _ in range(2)]
    sources = [str(uuid4()) for _ in range(2)]
    runs = [str(uuid4()) for _ in range(5)]

    def cleanup():
        with psycopg.connect(os.environ["TEST_DATABASE_ADMIN_URL"]) as admin:
            for table in ("page_changes", "source_snapshots", "source_runs", "sources", "products"):
                admin.execute(f"DELETE FROM marketrift.{table} WHERE tenant_id = ANY(%s::uuid[])", (tenants,))
            admin.execute("DELETE FROM marketrift.tenants WHERE id = ANY(%s::uuid[])", (tenants,))

    request.addfinalizer(cleanup)
    with psycopg.connect(os.environ["TEST_DATABASE_ADMIN_URL"]) as admin:
        for tenant, source in zip(tenants, sources, strict=True):
            product = str(uuid4())
            admin.execute("INSERT INTO marketrift.tenants (id, name) VALUES (%s, 'page-test')", (tenant,))
            admin.execute("INSERT INTO marketrift.products (id, tenant_id, name, kind) "
                          "VALUES (%s, %s, 'Competitor', 'competitor')", (product, tenant))
            admin.execute("INSERT INTO marketrift.sources "
                          "(id, tenant_id, product_id, source_type, url, check_interval_minutes) "
                          "VALUES (%s, %s, %s, 'pricing_page', 'https://example.com/pricing', 1440)",
                          (source, tenant, product))
        for run_id, tenant, source in ((runs[0], tenants[0], sources[0]),
                                       (runs[4], tenants[1], sources[1])):
            admin.execute("INSERT INTO marketrift.source_runs "
                          "(id, tenant_id, source_id, status, run_kind) "
                          "VALUES (%s, %s, %s, 'pending', 'web_page')", (run_id, tenant, source))

    def job(tenant, source, run_id):
        return {"version": 1, "tenant_id": tenant, "source_id": source, "run_id": run_id,
                "idempotency_key": f"web-page-{run_id}-v1"}

    with pytest.raises(PageError, match="source_product_or_run_not_in_tenant"):
        invoke(job(tenants[0], sources[1], runs[4]), markup(10))
    first = job(tenants[0], sources[0], runs[0])
    assert invoke(first, markup(10)) == {"status": "succeeded", "new_snapshot": True}
    assert invoke(first, markup(10))["replayed"] is True
    with psycopg.connect(os.environ["TEST_DATABASE_ADMIN_URL"]) as admin:
        for run_id in runs[1:4]:
            admin.execute("INSERT INTO marketrift.source_runs "
                          "(id, tenant_id, source_id, status, run_kind) "
                          "VALUES (%s, %s, %s, 'pending', 'web_page')",
                          (run_id, tenants[0], sources[0]))
            admin.commit()
            # Complete each run before making the next, matching the active-run unique index.
            if run_id == runs[1]:
                assert invoke(job(tenants[0], sources[0], run_id), markup(10))["new_snapshot"] is False
            elif run_id == runs[2]:
                assert invoke(job(tenants[0], sources[0], run_id), markup(12))["new_snapshot"] is True
            else:
                assert invoke(job(tenants[0], sources[0], run_id), "<main><script>empty</script></main>") == {
                    "status": "failed", "error_code": "no_extractable_content"}
    with psycopg.connect(os.environ["TEST_DATABASE_ADMIN_URL"]) as admin:
        versions = admin.execute("SELECT version_no, content_sha256 FROM marketrift.source_snapshots "
                                 "WHERE tenant_id = %s ORDER BY version_no", (tenants[0],)).fetchall()
        assert len(versions) == 2 and [row[0] for row in versions] == [1, 2]
        assert versions[0][1] != versions[1][1]
        details = admin.execute("SELECT change_details FROM marketrift.page_changes "
                                "WHERE tenant_id = %s", (tenants[0],)).fetchone()[0]
        assert details[0]["percent_change"] == "20.00"
        assert admin.execute("SELECT count(*) FROM marketrift.source_snapshots "
                             "WHERE tenant_id = %s", (tenants[1],)).fetchone()[0] == 0
    with psycopg.connect(os.environ["RUNTIME_DATABASE_URL"]) as runtime:
        runtime.execute("SELECT set_config('app.tenant_id', %s, true)", (tenants[1],))
        assert runtime.execute("SELECT count(*) FROM marketrift.source_snapshots "
                               "WHERE tenant_id = %s", (tenants[0],)).fetchone()[0] == 0
        assert runtime.execute("SELECT count(*) FROM marketrift.page_changes "
                               "WHERE tenant_id = %s", (tenants[0],)).fetchone()[0] == 0
        assert runtime.execute("UPDATE marketrift.source_snapshots SET normalized_text = 'bad' "
                               "WHERE tenant_id = %s", (tenants[0],)).rowcount == 0
    assert invoke(job(tenants[1], sources[1], runs[4]), markup(10))["new_snapshot"] is True
