"""Page snapshot persistence, replay, failure and tenant isolation in migrated PostgreSQL."""

import asyncio
import json
import os
from uuid import uuid4

import psycopg
import pytest

from marketrift_intelligence.page_reinterpret import reinterpret_snapshot
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


def invoke_error(job, code):
    def fail(_url, last_checked_at=None):
        raise PageError(code)

    async def work():
        return await check_web_page(job, fail)

    if os.name == "nt":
        return asyncio.run(work(), loop_factory=asyncio.SelectorEventLoop)
    return asyncio.run(work())


def markup(amount):
    return f"<main><section class='plan'><h2>Pro</h2><p>USD {amount} per month</p><p>API access</p></section></main>"


def test_paused_individual_page_is_manual_versioned_and_tenant_isolated(request):
    tenant_a, tenant_b = str(uuid4()), str(uuid4())
    source, product = str(uuid4()), str(uuid4())
    run_ids = [str(uuid4()) for _ in range(3)]

    def cleanup():
        with psycopg.connect(os.environ["TEST_DATABASE_ADMIN_URL"]) as admin:
            for table in ("page_changes", "snapshot_interpretations", "source_snapshots", "source_runs",
                          "sources", "products"):
                admin.execute(f"DELETE FROM marketrift.{table} WHERE tenant_id = ANY(%s::uuid[])",
                              ([tenant_a, tenant_b],))
            admin.execute("DELETE FROM marketrift.tenants WHERE id = ANY(%s::uuid[])",
                          ([tenant_a, tenant_b],))

    request.addfinalizer(cleanup)
    with psycopg.connect(os.environ["TEST_DATABASE_ADMIN_URL"]) as admin:
        for tenant in (tenant_a, tenant_b):
            admin.execute("INSERT INTO marketrift.tenants(id,name) VALUES (%s,'individual-test')", (tenant,))
        admin.execute("INSERT INTO marketrift.products(id,tenant_id,name,kind) "
                      "VALUES (%s,%s,'Controlled competitor','competitor')", (product, tenant_a))
        admin.execute("INSERT INTO marketrift.sources(id,tenant_id,product_id,source_type,url,monitoring_enabled) "
                      "VALUES (%s,%s,%s,'public_page','https://example.com/article',false)",
                      (source, tenant_a, product))
        admin.execute("INSERT INTO marketrift.source_runs(id,tenant_id,source_id,status,run_kind) "
                      "VALUES (%s,%s,%s,'pending','web_page')", (run_ids[0], tenant_a, source))

    def job(tenant, run_id):
        return {"version": 1, "tenant_id": tenant, "source_id": source, "run_id": run_id,
                "idempotency_key": f"web-page-{run_id}-v1"}

    html = "<main><h1>Public article</h1><p>A literal public product statement.</p></main>"
    with pytest.raises(PageError, match="source_product_or_run_not_in_tenant"):
        invoke(job(tenant_b, run_ids[0]), html)
    assert invoke(job(tenant_a, run_ids[0]), html) == {"status": "succeeded", "new_snapshot": True}
    assert invoke(job(tenant_a, run_ids[0]), html)["replayed"] is True
    for run_id, markup_text, expected in ((run_ids[1], html, False),
                                          (run_ids[2], html.replace("literal", "updated"), True)):
        with psycopg.connect(os.environ["TEST_DATABASE_ADMIN_URL"]) as admin:
            admin.execute("INSERT INTO marketrift.source_runs(id,tenant_id,source_id,status,run_kind) "
                          "VALUES (%s,%s,%s,'pending','web_page')", (run_id, tenant_a, source))
        assert invoke(job(tenant_a, run_id), markup_text)["new_snapshot"] is expected
    with psycopg.connect(os.environ["TEST_DATABASE_ADMIN_URL"]) as admin:
        assert admin.execute("SELECT count(*) FROM marketrift.source_snapshots WHERE source_id=%s",
                             (source,)).fetchone()[0] == 2
        assert admin.execute("SELECT count(*) FROM marketrift.page_changes WHERE source_id=%s",
                             (source,)).fetchone()[0] == 0
        assert admin.execute("SELECT monitoring_enabled FROM marketrift.sources WHERE id=%s",
                             (source,)).fetchone()[0] is False
    with psycopg.connect(os.environ["RUNTIME_DATABASE_URL"]) as runtime:
        runtime.execute("SELECT set_config('app.tenant_id',%s,true)", (tenant_b,))
        assert runtime.execute("SELECT count(*) FROM marketrift.source_snapshots WHERE source_id=%s",
                               (source,)).fetchone()[0] == 0


def test_legacy_skip_capture_remains_historical_after_new_observation(request):
    tenant, source, product = [str(uuid4()) for _ in range(3)]
    old_run, new_run = str(uuid4()), str(uuid4())

    def cleanup():
        with psycopg.connect(os.environ["TEST_DATABASE_ADMIN_URL"]) as admin:
            for table in ("page_changes", "snapshot_interpretations", "source_snapshots", "source_runs",
                          "sources", "products"):
                admin.execute(f"DELETE FROM marketrift.{table} WHERE tenant_id=%s", (tenant,))
            admin.execute("DELETE FROM marketrift.tenants WHERE id=%s", (tenant,))

    request.addfinalizer(cleanup)
    with psycopg.connect(os.environ["TEST_DATABASE_ADMIN_URL"]) as admin:
        admin.execute("INSERT INTO marketrift.tenants(id,name) VALUES (%s,'legacy-page-test')", (tenant,))
        admin.execute("INSERT INTO marketrift.products(id,tenant_id,name,kind) "
                      "VALUES (%s,%s,'Controlled competitor','competitor')", (product, tenant))
        admin.execute("INSERT INTO marketrift.sources(id,tenant_id,product_id,source_type,url,monitoring_enabled) "
                      "VALUES (%s,%s,%s,'public_page','https://example.com/article',false)",
                      (source, tenant, product))
        admin.execute("INSERT INTO marketrift.source_runs(id,tenant_id,source_id,status,run_kind) "
                      "VALUES (%s,%s,%s,'succeeded','web_page'),(%s,%s,%s,'pending','web_page')",
                      (old_run, tenant, source, new_run, tenant, source))
        old = {"kind": "public_page", "text": "Skip to content", "excerpt": "Skip to content",
               "extractor_version": 3, "status": "unconfirmed", "reason": "public_page_observation"}
        admin.execute("INSERT INTO marketrift.source_snapshots "
                      "(tenant_id,source_id,run_id,source_url,storage_key,content_sha256,version_no,"
                      "final_url,normalized_text,extracted,interpretation_version,interpretation_status,"
                      "interpretation_reason) VALUES (%s,%s,%s,'https://example.com/article',"
                      "'legacy:test',%s,1,'https://example.com/article','Skip to content',%s::jsonb,"
                      "3,'unconfirmed','public_page_observation')",
                      (tenant, source, old_run, "a" * 64, json.dumps(old)))
    job = {"version": 1, "tenant_id": tenant, "source_id": source, "run_id": new_run,
           "idempotency_key": f"web-page-{new_run}-v1"}
    html = ('<main><a href="#article">Skip to content</a></main><article><h1>Update</h1>'
            '<p>The product now supports a controlled upload method.</p></article>')
    assert invoke(job, html) == {"status": "succeeded", "new_snapshot": True}
    with psycopg.connect(os.environ["TEST_DATABASE_ADMIN_URL"]) as admin:
        rows = admin.execute("SELECT version_no,content_sha256,normalized_text,extracted "
                             "FROM marketrift.source_snapshots WHERE tenant_id=%s AND source_id=%s "
                             "ORDER BY version_no", (tenant, source)).fetchall()
        assert len(rows) == 2
        assert rows[0][1:3] == ("a" * 64, "Skip to content")
        assert rows[1][2].startswith("Update\nThe product now supports")
        assert rows[1][3]["comparison_status"] == "previous_markup_unavailable"
        assert admin.execute("SELECT count(*) FROM marketrift.page_changes WHERE tenant_id=%s",
                             (tenant,)).fetchone()[0] == 0


def test_two_tenants_snapshots_changes_replay_and_unextractable(request):
    tenants = [str(uuid4()) for _ in range(2)]
    sources = [str(uuid4()) for _ in range(2)]
    runs = [str(uuid4()) for _ in range(7)]

    def cleanup():
        with psycopg.connect(os.environ["TEST_DATABASE_ADMIN_URL"]) as admin:
            for table in ("reviewable_signals", "page_changes", "snapshot_interpretations", "source_snapshots", "source_runs", "sources", "products"):
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
                          "(id, tenant_id, product_id, source_type, url, check_interval_minutes, "
                          "monitoring_enabled, next_check_at) "
                          "VALUES (%s, %s, %s, 'pricing_page', 'https://example.com/pricing', 60, "
                          "true, now())",
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
        versions = admin.execute("SELECT version_no, content_sha256, interpretation_status, "
                                 "interpretation_version FROM marketrift.source_snapshots "
                                 "WHERE tenant_id = %s ORDER BY version_no", (tenants[0],)).fetchall()
        assert len(versions) == 2 and [row[0] for row in versions] == [1, 2]
        assert versions[0][1] != versions[1][1]
        assert all(row[2:] == ("confirmed", 3) for row in versions)
        details = admin.execute("SELECT change_details FROM marketrift.page_changes "
                                "WHERE tenant_id = %s", (tenants[0],)).fetchone()[0]
        assert details[0]["percent_change"] == "20.00"
        assert admin.execute("SELECT count(*) FROM marketrift.source_snapshots "
                             "WHERE tenant_id = %s", (tenants[1],)).fetchone()[0] == 0
        next_at, failures = admin.execute(
            "SELECT next_check_at, consecutive_failures FROM marketrift.sources "
            "WHERE tenant_id = %s AND id = %s", (tenants[0], sources[0])).fetchone()
        assert failures == 1 and next_at > admin.execute("SELECT now() + interval '59 minutes'").fetchone()[0]
        admin.execute("INSERT INTO marketrift.source_runs (id, tenant_id, source_id, status, run_kind) "
                      "VALUES (%s, %s, %s, 'pending', 'web_page')", (runs[5], tenants[0], sources[0]))
    assert invoke_error(job(tenants[0], sources[0], runs[5]), "network_failure") == {
        "status": "failed", "error_code": "network_failure"}
    with psycopg.connect(os.environ["TEST_DATABASE_ADMIN_URL"]) as admin:
        next_at, failures = admin.execute(
            "SELECT next_check_at, consecutive_failures FROM marketrift.sources "
            "WHERE tenant_id = %s AND id = %s", (tenants[0], sources[0])).fetchone()
        assert failures == 2 and next_at > admin.execute("SELECT now() + interval '9 minutes'").fetchone()[0]
    with psycopg.connect(os.environ["RUNTIME_DATABASE_URL"]) as runtime:
        runtime.execute("SELECT set_config('app.tenant_id', %s, true)", (tenants[1],))
        assert runtime.execute("SELECT count(*) FROM marketrift.source_snapshots "
                               "WHERE tenant_id = %s", (tenants[0],)).fetchone()[0] == 0
        assert runtime.execute("SELECT count(*) FROM marketrift.page_changes "
                               "WHERE tenant_id = %s", (tenants[0],)).fetchone()[0] == 0
        assert runtime.execute("UPDATE marketrift.source_snapshots SET normalized_text = 'bad' "
                               "WHERE tenant_id = %s", (tenants[0],)).rowcount == 0
    # Pre-v2 structured JSON is retained as evidence but marked for human review.
    with psycopg.connect(os.environ["TEST_DATABASE_ADMIN_URL"]) as admin:
        admin.execute("INSERT INTO marketrift.source_runs (id, tenant_id, source_id, status, run_kind) "
                      "VALUES (%s, %s, %s, 'succeeded', 'web_page')", (runs[6], tenants[1], sources[1]))
        old = {"kind": "pricing_page", "text": "Old editorial article", "status": "structured",
               "plans": [{"name": "Pro", "amount": "10", "currency": "USD", "period": "month",
                          "conditions": "API access", "confirmed": True, "evidence": "Old editorial article"}]}
        admin.execute("INSERT INTO marketrift.source_snapshots "
                      "(tenant_id, source_id, run_id, source_url, storage_key, content_sha256, "
                      "version_no, final_url, normalized_text, extracted) "
                      "VALUES (%s, %s, %s, 'https://example.com/pricing', 'legacy:test', %s, 1, "
                      "'https://example.com/pricing', 'Old editorial article', %s::jsonb)",
                      (tenants[1], sources[1], runs[6], "0" * 64, json.dumps(old)))
        status, version = admin.execute(
            "SELECT interpretation_status, interpretation_version FROM marketrift.source_snapshots "
            "WHERE tenant_id = %s AND run_id = %s", (tenants[1], runs[6])).fetchone()
        assert (status, version) == ("needs_review", None)
    assert invoke(job(tenants[1], sources[1], runs[4]), markup(10))["new_snapshot"] is True
    with psycopg.connect(os.environ["TEST_DATABASE_ADMIN_URL"]) as admin:
        changes = admin.execute("SELECT change_details FROM marketrift.page_changes "
                                "WHERE tenant_id = %s", (tenants[1],)).fetchone()[0]
        assert changes[0]["kind"] == "text_changed_unconfirmed"
        assert all(item.get("percent_change") is None for item in changes)


def test_reinterpretation_preserves_snapshot_history_and_tenant_boundary(request):
    tenants = [str(uuid4()) for _ in range(2)]
    product, source, run, interpretation = (str(uuid4()) for _ in range(4))

    def cleanup():
        with psycopg.connect(os.environ["TEST_DATABASE_ADMIN_URL"]) as admin:
            for table in ("reviewable_signals", "page_changes", "snapshot_interpretations", "source_snapshots", "source_runs", "sources", "products"):
                admin.execute(f"DELETE FROM marketrift.{table} WHERE tenant_id = ANY(%s::uuid[])", (tenants,))
            admin.execute("DELETE FROM marketrift.tenants WHERE id = ANY(%s::uuid[])", (tenants,))

    request.addfinalizer(cleanup)
    with psycopg.connect(os.environ["TEST_DATABASE_ADMIN_URL"]) as admin:
        for tenant in tenants:
            admin.execute("INSERT INTO marketrift.tenants (id,name) VALUES (%s,'reinterpret-test')", (tenant,))
        admin.execute("INSERT INTO marketrift.products (id,tenant_id,name,kind) "
                      "VALUES (%s,%s,'Competitor','competitor')", (product, tenants[0]))
        admin.execute("INSERT INTO marketrift.sources "
                      "(id,tenant_id,product_id,source_type,url,check_interval_minutes) "
                      "VALUES (%s,%s,%s,'release_notes','https://example.com/changelog',60)",
                      (source, tenants[0], product))
        admin.execute("INSERT INTO marketrift.source_runs (id,tenant_id,source_id,status,run_kind) "
                      "VALUES (%s,%s,%s,'pending','web_page')", (run, tenants[0], source))
    job = {"version": 1, "tenant_id": tenants[0], "source_id": source, "run_id": run,
           "idempotency_key": f"web-page-{run}-v1"}
    html = ("<main><h1>Changelog</h1><div>25 September</div><article>"
            "<h2><a href='/changelog/new-feature'>New feature</a></h2>"
            "<p>The product now supports offline exports.</p></article></main>")
    assert invoke(job, html)["new_snapshot"] is True
    with psycopg.connect(os.environ["TEST_DATABASE_ADMIN_URL"]) as admin:
        snapshot, original_hash, original_text, old_extracted = admin.execute(
            "SELECT id,content_sha256,normalized_text,extracted FROM marketrift.source_snapshots "
            "WHERE tenant_id=%s AND source_id=%s", (tenants[0], source)).fetchone()
        admin.execute("UPDATE marketrift.source_snapshots SET interpretation_version=2,"
                      "interpretation_status='unconfirmed',interpretation_reason='release_entries_missing',"
                      "extracted=%s::jsonb WHERE tenant_id=%s AND id=%s",
                      (json.dumps({**old_extracted, "entries": [], "status": "unconfirmed",
                                   "reason": "release_entries_missing"}), tenants[0], snapshot))
        admin.execute("DELETE FROM marketrift.snapshot_interpretations WHERE tenant_id=%s AND snapshot_id=%s",
                      (tenants[0], snapshot))
        admin.execute("INSERT INTO marketrift.snapshot_interpretations "
                      "(tenant_id,source_id,snapshot_id,rule_version,status,interpretation_status,"
                      "reason,extracted,basis) VALUES (%s,%s,%s,2,'completed','unconfirmed',"
                      "'release_entries_missing',%s::jsonb,'initial_capture')",
                      (tenants[0], source, snapshot, json.dumps(old_extracted)))
        admin.execute("INSERT INTO marketrift.snapshot_interpretations "
                      "(id,tenant_id,source_id,snapshot_id,rule_version,status,reason,basis) "
                      "VALUES (%s,%s,%s,%s,3,'pending','queued','stored_markup')",
                      (interpretation, tenants[0], source, snapshot))
        revision_before = admin.execute("SELECT requested_revision FROM marketrift.signal_reconcile_sources "
                                        "WHERE tenant_id=%s AND source_id=%s",
                                        (tenants[0], source)).fetchone()[0]
    replay = {"version": 1, "tenant_id": tenants[0], "source_id": source,
              "snapshot_id": str(snapshot), "interpretation_id": interpretation,
              "rule_version": 3, "idempotency_key": f"page-reinterpret-{interpretation}-v1"}
    async def work(payload):
        return await reinterpret_snapshot(payload)

    def run_async(payload):
        return asyncio.run(work(payload), loop_factory=asyncio.SelectorEventLoop) if os.name == "nt" else asyncio.run(work(payload))

    with pytest.raises(PageError, match="interpretation_not_in_tenant"):
        run_async({**replay, "tenant_id": tenants[1]})
    assert run_async(replay)["status"] == "completed"
    assert run_async(replay)["replayed"] is True
    with psycopg.connect(os.environ["TEST_DATABASE_ADMIN_URL"]) as admin:
        rows = admin.execute("SELECT version_no,content_sha256,normalized_text,interpretation_version,"
                             "interpretation_status,extracted FROM marketrift.source_snapshots "
                             "WHERE tenant_id=%s AND source_id=%s", (tenants[0], source)).fetchall()
        assert len(rows) == 1
        assert rows[0][:4] == (1, original_hash, original_text, 3)
        assert rows[0][4] == "confirmed"
        assert rows[0][5]["entries"][0]["date_evidence"] == "25 September"
        history = admin.execute("SELECT rule_version,status,interpretation_status "
                                "FROM marketrift.snapshot_interpretations WHERE tenant_id=%s "
                                "AND snapshot_id=%s ORDER BY rule_version", (tenants[0], snapshot)).fetchall()
        assert history == [(2, "completed", "unconfirmed"), (3, "completed", "confirmed")]
        assert admin.execute("SELECT count(*) FROM marketrift.page_changes WHERE tenant_id=%s",
                             (tenants[0],)).fetchone()[0] == 0
        revision_after = admin.execute("SELECT requested_revision FROM marketrift.signal_reconcile_sources "
                                       "WHERE tenant_id=%s AND source_id=%s",
                                       (tenants[0], source)).fetchone()[0]
        assert revision_after == revision_before + 1
