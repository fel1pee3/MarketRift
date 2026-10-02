"""Tenant and idempotence checks against migrated PostgreSQL, with a controlled fetcher."""
import asyncio
import os
from uuid import uuid4

import psycopg
import pytest
from test_feeds import URL, rss

from marketrift_intelligence.feeds import FeedError, parse_feed, sync_feed

pytestmark = pytest.mark.skipif(not (os.getenv("TEST_DATABASE_ADMIN_URL") and os.getenv("RUNTIME_DATABASE_URL")),
    reason="requires migrated PostgreSQL")


def invoke(job, fetcher):
    if os.name == "nt":
        return asyncio.run(sync_feed(job, fetcher), loop_factory=asyncio.SelectorEventLoop)
    return asyncio.run(sync_feed(job, fetcher))


def job(tenant, source, run, generation=None):
    result = {"version":1,"tenant_id":tenant,"source_id":source,"run_id":run,
              "idempotency_key":f"feed-{run}-v1"}
    if generation is not None: result["monitor_generation"] = generation
    return result


def test_two_tenants_repeat_edit_pause_and_rls(request):
    tenants = [str(uuid4()), str(uuid4())]
    sources = [str(uuid4()), str(uuid4())]
    runs = [str(uuid4()) for _ in range(6)]

    def cleanup():
        with psycopg.connect(os.environ["TEST_DATABASE_ADMIN_URL"]) as admin:
            for table in ("feed_entry_versions","feed_entries","source_runs","sources","products"):
                admin.execute(f"DELETE FROM marketrift.{table} WHERE tenant_id=ANY(%s::uuid[])", (tenants,))
            admin.execute("DELETE FROM marketrift.tenants WHERE id=ANY(%s::uuid[])", (tenants,))
    request.addfinalizer(cleanup)

    with psycopg.connect(os.environ["TEST_DATABASE_ADMIN_URL"]) as admin:
        for tenant, source in zip(tenants,sources):
            product = str(uuid4())
            admin.execute("INSERT INTO marketrift.tenants(id,name) VALUES (%s,'feed-test')",(tenant,))
            admin.execute("INSERT INTO marketrift.products(id,tenant_id,name,kind) "
                          "VALUES (%s,%s,'Competitor','competitor')",(product,tenant))
            admin.execute("INSERT INTO marketrift.sources(id,tenant_id,product_id,source_type,url,"
                          "monitoring_enabled,check_interval_minutes,next_check_at) "
                          "VALUES (%s,%s,%s,'rss_feed',%s,true,1440,now()+interval '1 day')",
                          (source,tenant,product,URL))
        for tenant, source, run in ((tenants[0],sources[0],runs[0]),(tenants[1],sources[1],runs[1])):
            admin.execute("INSERT INTO marketrift.source_runs(id,tenant_id,source_id,status,run_kind,"
                          "feed_monitor_generation) VALUES (%s,%s,%s,'pending','feed',1)",
                          (run,tenant,source))

    calls = []
    def fetch(_url, **kwargs):
        calls.append(kwargs)
        kwargs["before_request"]()
        return parse_feed(rss(), URL)[0],True,'"a"',None,False

    with pytest.raises(FeedError, match="source_not_found"):
        invoke(job(tenants[0],sources[1],runs[1],1),fetch)
    assert calls == []
    assert invoke(job(tenants[0],sources[0],runs[0],1),fetch)["new"] == 1
    assert invoke(job(tenants[0],sources[0],runs[0],1),fetch)["replayed"] is True
    assert len(calls) == 1
    with psycopg.connect(os.environ["RUNTIME_DATABASE_URL"]) as runtime:
        runtime.execute("SELECT set_config('app.tenant_id',%s,true)",(tenants[1],))
        assert runtime.execute("SELECT count(*) FROM marketrift.feed_entries WHERE tenant_id=%s",
                               (tenants[0],)).fetchone()[0] == 0

    with psycopg.connect(os.environ["TEST_DATABASE_ADMIN_URL"]) as admin:
        admin.execute("INSERT INTO marketrift.source_runs(id,tenant_id,source_id,status,run_kind,"
                      "feed_monitor_generation) VALUES (%s,%s,%s,'pending','feed',1)",
                      (runs[2],tenants[0],sources[0]))
    assert invoke(job(tenants[0],sources[0],runs[2],1),fetch)["new"] == 0
    def edited(_url, **kwargs):
        kwargs["before_request"]()
        return parse_feed(rss(title="Edited release"),URL)[0],True,'"b"',None,False
    with psycopg.connect(os.environ["TEST_DATABASE_ADMIN_URL"]) as admin:
        admin.execute("INSERT INTO marketrift.source_runs(id,tenant_id,source_id,status,run_kind,"
                      "feed_monitor_generation) VALUES (%s,%s,%s,'pending','feed',1)",
                      (runs[3],tenants[0],sources[0]))
    assert invoke(job(tenants[0],sources[0],runs[3],1),edited)["updated"] == 1
    with psycopg.connect(os.environ["TEST_DATABASE_ADMIN_URL"]) as admin:
        assert admin.execute("SELECT count(*),max(version_no) FROM marketrift.feed_entries "
                             "WHERE tenant_id=%s",(tenants[0],)).fetchone() == (1,2)
        assert admin.execute("SELECT count(*) FROM marketrift.feed_entry_versions "
                             "WHERE tenant_id=%s",(tenants[0],)).fetchone()[0] == 2
        admin.execute("INSERT INTO marketrift.source_runs(id,tenant_id,source_id,status,run_kind,"
                      "feed_monitor_generation) VALUES (%s,%s,%s,'pending','feed',1)",
                      (runs[4],tenants[0],sources[0]))
        admin.execute("UPDATE marketrift.sources SET monitoring_enabled=false,next_check_at=NULL "
                      "WHERE id=%s",(sources[0],))
    assert invoke(job(tenants[0],sources[0],runs[4],1),fetch)["status"] == "cancelled"
    with psycopg.connect(os.environ["TEST_DATABASE_ADMIN_URL"]) as admin:
        admin.execute("UPDATE marketrift.sources SET monitoring_enabled=true,next_check_at=now()+interval '1 day' "
                      "WHERE id=%s",(sources[0],))
        admin.execute("INSERT INTO marketrift.source_runs(id,tenant_id,source_id,status,run_kind,"
                      "feed_monitor_generation) VALUES (%s,%s,%s,'pending','feed',2)",
                      (runs[5],tenants[0],sources[0]))
    assert invoke(job(tenants[0],sources[0],runs[5],2),fetch)["status"] == "cancelled"
    assert len(calls) == 2, "Paused and stale jobs must not fetch"
    with psycopg.connect(os.environ["TEST_DATABASE_ADMIN_URL"]) as admin:
        assert admin.execute("SELECT count(*) FROM marketrift.feed_entry_versions "
                             "WHERE tenant_id=%s",(tenants[0],)).fetchone()[0] == 2
