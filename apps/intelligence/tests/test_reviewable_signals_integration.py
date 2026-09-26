"""RLS and individual alert reads for reviewable signals, using temporary tenants."""
import os
from uuid import uuid4

import psycopg
import pytest

pytestmark = pytest.mark.skipif(
    not (os.getenv("TEST_DATABASE_ADMIN_URL") and os.getenv("RUNTIME_DATABASE_URL")),
    reason="requires migrated PostgreSQL",
)


def test_signal_and_alert_reads_are_tenant_scoped(request):
    tenant_a, tenant_b, user = (str(uuid4()) for _ in range(3))
    product, source, signal = (str(uuid4()) for _ in range(3))

    def cleanup():
        with psycopg.connect(os.environ["TEST_DATABASE_ADMIN_URL"]) as db:
            db.execute("DELETE FROM marketrift.signal_alert_reads WHERE tenant_id IN (%s,%s)",
                       (tenant_a, tenant_b))
            db.execute("DELETE FROM marketrift.reviewable_signals WHERE tenant_id IN (%s,%s)",
                       (tenant_a, tenant_b))
            db.execute("DELETE FROM marketrift.sources WHERE tenant_id IN (%s,%s)", (tenant_a, tenant_b))
            db.execute("DELETE FROM marketrift.products WHERE tenant_id IN (%s,%s)", (tenant_a, tenant_b))
            db.execute("DELETE FROM marketrift.memberships WHERE tenant_id IN (%s,%s)",
                       (tenant_a, tenant_b))
            db.execute("DELETE FROM marketrift.tenants WHERE id IN (%s,%s)", (tenant_a, tenant_b))
            db.execute("DELETE FROM marketrift.users WHERE id=%s", (user,))

    request.addfinalizer(cleanup)
    with psycopg.connect(os.environ["TEST_DATABASE_ADMIN_URL"]) as db:
        db.execute("INSERT INTO marketrift.users (id,email,display_name,password_hash) "
                   "VALUES (%s,%s,'Signal tester','test-only-unusable')",
                   (user, f"signals-{user}@example.invalid"))
        for tenant in (tenant_a, tenant_b):
            db.execute("INSERT INTO marketrift.tenants (id,name) VALUES (%s,'signals-test')", (tenant,))
            db.execute("INSERT INTO marketrift.memberships (tenant_id,user_id,role) "
                       "VALUES (%s,%s,'owner')", (tenant, user))
        db.execute("INSERT INTO marketrift.products (id,tenant_id,name,kind) "
                   "VALUES (%s,%s,'Synthetic signal product','competitor')", (product, tenant_a))
        db.execute("INSERT INTO marketrift.sources (id,tenant_id,product_id,source_type,url) "
                   "VALUES (%s,%s,%s,'github_discussions','https://github.com/example/repo')",
                   (source, tenant_a, product))
        db.execute("INSERT INTO marketrift.reviewable_signals "
                   "(id,tenant_id,fact_key,rule_version,signal_type,source_type,source_id,summary,"
                   "interpretation_limit,evidence,evidence_hash,observed_at,test_data,state) "
                   "VALUES (%s,%s,%s,'observed-facts-v1','github_discussion_activity',"
                   "'github_discussions',%s,'Synthetic public activity','Test only','{}'::jsonb,%s,now(),true,'approved')",
                   (signal, tenant_a, "a" * 64, source, "b" * 64))

    with psycopg.connect(os.environ["RUNTIME_DATABASE_URL"]) as db:
        db.execute("SELECT set_config('app.tenant_id',%s,true)", (tenant_b,))
        assert db.execute("SELECT count(*) FROM marketrift.reviewable_signals").fetchone()[0] == 0
        assert db.execute("SELECT count(*) FROM marketrift.signal_alert_reads").fetchone()[0] == 0
        with pytest.raises(psycopg.errors.InsufficientPrivilege), db.transaction():
            db.execute("INSERT INTO marketrift.signal_alert_reads (tenant_id,signal_id,user_id) "
                       "VALUES (%s,%s,%s)", (tenant_a, signal, user))
        db.rollback()
        db.execute("SELECT set_config('app.tenant_id',%s,true)", (tenant_a,))
        assert db.execute("SELECT count(*) FROM marketrift.reviewable_signals WHERE id=%s",
                          (signal,)).fetchone()[0] == 1
        db.execute("INSERT INTO marketrift.signal_alert_reads (tenant_id,signal_id,user_id) "
                   "VALUES (%s,%s,%s)", (tenant_a, signal, user))
        assert db.execute("SELECT count(*) FROM marketrift.signal_alert_reads").fetchone()[0] == 1
        db.execute("DELETE FROM marketrift.signal_alert_reads WHERE signal_id=%s", (signal,))
        assert db.execute("SELECT count(*) FROM marketrift.signal_alert_reads").fetchone()[0] == 0
