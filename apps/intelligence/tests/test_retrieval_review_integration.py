"""Isolated RLS checks for frozen retrieval review data; no model or external service."""
import os
from uuid import uuid4

import psycopg
import pytest

pytestmark = pytest.mark.skipif(
    not (os.getenv("TEST_DATABASE_ADMIN_URL") and os.getenv("RUNTIME_DATABASE_URL")),
    reason="requires migrated PostgreSQL",
)


def test_retrieval_sets_questions_and_reports_are_tenant_scoped(request):
    tenant_a, tenant_b, user = str(uuid4()), str(uuid4()), str(uuid4())
    set_id, question_id = str(uuid4()), str(uuid4())

    def cleanup():
        with psycopg.connect(os.environ["TEST_DATABASE_ADMIN_URL"]) as db:
            db.execute("DELETE FROM marketrift.retrieval_sets WHERE tenant_id IN (%s, %s)",
                       (tenant_a, tenant_b))
            db.execute("DELETE FROM marketrift.tenants WHERE id IN (%s, %s)", (tenant_a, tenant_b))
            db.execute("DELETE FROM marketrift.users WHERE id = %s", (user,))

    request.addfinalizer(cleanup)
    with psycopg.connect(os.environ["TEST_DATABASE_ADMIN_URL"]) as db:
        db.execute("INSERT INTO marketrift.users (id,email,display_name,password_hash) "
                   "VALUES (%s,%s,'Reviewer','test-only-unusable')",
                   (user, f"retrieval-{user}@example.invalid"))
        for tenant in (tenant_a, tenant_b):
            db.execute("INSERT INTO marketrift.tenants (id,name) VALUES (%s,'retrieval-test')", (tenant,))
        db.execute("INSERT INTO marketrift.retrieval_sets (id,tenant_id,title,origin,created_by) "
                   "VALUES (%s,%s,'Synthetic RLS fixture','synthetic_test',%s)", (set_id, tenant_a, user))
        db.execute("INSERT INTO marketrift.retrieval_questions "
                   "(id,tenant_id,set_id,text_content,language,created_by) "
                   "VALUES (%s,%s,%s,'What changed?','en',%s)", (question_id, tenant_a, set_id, user))
        db.execute("INSERT INTO marketrift.retrieval_reports "
                   "(tenant_id,set_id,corpus_hash,judgment_hash,result,created_by) "
                   "VALUES (%s,%s,%s,%s,'{}'::jsonb,%s)", (tenant_a, set_id, "a" * 64, "b" * 64, user))
    with psycopg.connect(os.environ["RUNTIME_DATABASE_URL"]) as db:
        db.execute("SELECT set_config('app.tenant_id', %s, true)", (tenant_b,))
        for table in ("retrieval_sets", "retrieval_items", "retrieval_questions",
                      "retrieval_judgments", "retrieval_reports"):
            assert db.execute(f"SELECT count(*) FROM marketrift.{table}").fetchone()[0] == 0
        with pytest.raises(psycopg.errors.InsufficientPrivilege), db.transaction():
            db.execute("INSERT INTO marketrift.retrieval_sets (tenant_id,title,created_by) "
                       "VALUES (%s,'Forbidden cross-tenant',%s)", (tenant_a, user))
        db.rollback()
        db.execute("SELECT set_config('app.tenant_id', %s, true)", (tenant_a,))
        assert db.execute("SELECT count(*) FROM marketrift.retrieval_sets WHERE id = %s",
                          (set_id,)).fetchone()[0] == 1
        assert db.execute("SELECT count(*) FROM marketrift.retrieval_questions WHERE id = %s",
                          (question_id,)).fetchone()[0] == 1
        assert db.execute("SELECT count(*) FROM marketrift.retrieval_reports").fetchone()[0] == 1
