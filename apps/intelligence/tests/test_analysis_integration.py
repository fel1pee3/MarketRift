"""Real PostgreSQL/RLS checks for versioned analysis; no external model is called."""

import asyncio
import os
from uuid import uuid4

import psycopg
import pytest

import marketrift_intelligence.analyze as analysis_module
from marketrift_intelligence.analysis_job import make_analysis_job
from marketrift_intelligence.extract import EXTRACTOR_VERSION, extract_review

pytestmark = pytest.mark.skipif(
    not (os.getenv("TEST_DATABASE_ADMIN_URL") and os.getenv("RUNTIME_DATABASE_URL")),
    reason="requires migrated PostgreSQL",
)


def run(job):
    if os.name == "nt":
        return asyncio.run(analysis_module.analyze(job), loop_factory=asyncio.SelectorEventLoop)
    return asyncio.run(analysis_module.analyze(job))


def test_analysis_isolation_replay_failure_and_multiple_issues(request, monkeypatch):
    monkeypatch.setenv("ANALYSIS_PROVIDER", "test")
    monkeypatch.setenv("MARKETRIFT_TEST_MODE", "1")
    tenant_a, tenant_b = str(uuid4()), str(uuid4())
    document_a, positive_a, document_b = str(uuid4()), str(uuid4()), str(uuid4())

    def cleanup():
        with psycopg.connect(os.environ["TEST_DATABASE_ADMIN_URL"]) as admin:
            for table in ("insights", "document_analyses", "documents", "sources", "products"):
                admin.execute(f"DELETE FROM marketrift.{table} WHERE tenant_id IN (%s, %s)",
                              (tenant_a, tenant_b))
            admin.execute("DELETE FROM marketrift.tenants WHERE id IN (%s, %s)", (tenant_a, tenant_b))

    request.addfinalizer(cleanup)
    with psycopg.connect(os.environ["TEST_DATABASE_ADMIN_URL"]) as admin:
        for tenant, documents in (
            (tenant_a, [(document_a, "O suporte demorou três dias e o preço aumentou sem aviso."),
                        (positive_a, "Gostei muito da facilidade de uso.")]),
            (tenant_b, [(document_b, "Fui cobrado duas vezes no mesmo mês.")]),
        ):
            product, source = str(uuid4()), str(uuid4())
            admin.execute("INSERT INTO marketrift.tenants (id, name) VALUES (%s, 'analysis-test')", (tenant,))
            admin.execute("INSERT INTO marketrift.products (id, tenant_id, name, kind) "
                          "VALUES (%s, %s, 'Competitor', 'competitor')", (product, tenant))
            admin.execute("INSERT INTO marketrift.sources (id, tenant_id, product_id, source_type, url) "
                          "VALUES (%s, %s, %s, 'manual_review', 'https://example.invalid')",
                          (source, tenant, product))
            for document, body in documents:
                admin.execute("INSERT INTO marketrift.documents "
                              "(id, tenant_id, source_id, document_type, external_key, source_url, body, synthetic) "
                              "VALUES (%s, %s, %s, 'review', %s, 'https://example.invalid/review', %s, true)",
                              (document, tenant, source, document, body))
                admin.execute("INSERT INTO marketrift.document_analyses "
                              "(tenant_id, document_id, extractor_version) VALUES (%s, %s, %s)",
                              (tenant, document, EXTRACTOR_VERSION))

    job_a = make_analysis_job(tenant_a, document_a, EXTRACTOR_VERSION)
    with pytest.raises(ValueError, match="does not belong"):
        run(make_analysis_job(tenant_b, document_a, EXTRACTOR_VERSION))
    assert run(job_a) == {"status": "completed", "issues": 2, "replayed": False}
    assert run(job_a) == {"status": "completed", "replayed": True}
    assert run(make_analysis_job(tenant_a, positive_a, EXTRACTOR_VERSION))["issues"] == 0
    with psycopg.connect(os.environ["TEST_DATABASE_ADMIN_URL"]) as admin:
        rows = admin.execute("SELECT category, evidence_quote FROM marketrift.insights "
                             "WHERE tenant_id = %s ORDER BY category", (tenant_a,)).fetchall()
        assert [row[0] for row in rows] == ["price", "support"]
        assert all(row[1] in "O suporte demorou três dias e o preço aumentou sem aviso." for row in rows)
        assert admin.execute("SELECT attempt_count FROM marketrift.document_analyses "
                             "WHERE tenant_id = %s AND document_id = %s", (tenant_a, document_a)).fetchone()[0] == 1
        metadata = admin.execute(
            "SELECT model_id, prompt_version, schema_version, taxonomy_version, "
            "started_at IS NOT NULL, completed_at IS NOT NULL "
            "FROM marketrift.document_analyses WHERE tenant_id = %s AND document_id = %s",
            (tenant_a, document_a),
        ).fetchone()
        assert metadata == ("controlled-test-fixture-v1", "review-issues-prompt-v1",
                            "review-issues-schema-v1", "review-issues-taxonomy-v1", True, True)

    with psycopg.connect(os.environ["RUNTIME_DATABASE_URL"]) as runtime:
        runtime.execute("SELECT set_config('app.tenant_id', %s, true)", (tenant_b,))
        assert runtime.execute("SELECT count(*) FROM marketrift.insights").fetchone()[0] == 0
        assert runtime.execute("UPDATE marketrift.document_analyses SET status = 'failed' "
                               "WHERE tenant_id = %s", (tenant_a,)).rowcount == 0

    job_b = make_analysis_job(tenant_b, document_b, EXTRACTOR_VERSION)
    monkeypatch.setenv("ANALYSIS_PROVIDER", "disabled")
    assert run(job_b)["status"] == "unavailable"
    monkeypatch.setenv("ANALYSIS_PROVIDER", "test")

    async def provider_failure(_body):
        raise RuntimeError("provider went away")

    monkeypatch.setattr(analysis_module, "extract_review", provider_failure)
    with pytest.raises(RuntimeError, match="RuntimeError"):
        run(job_b)
    with psycopg.connect(os.environ["TEST_DATABASE_ADMIN_URL"]) as admin:
        status, error = admin.execute("SELECT status, last_error FROM marketrift.document_analyses "
                                      "WHERE tenant_id = %s AND document_id = %s", (tenant_b, document_b)).fetchone()
        assert (status, error) == ("failed", "RuntimeError")
        assert admin.execute("SELECT count(*) FROM marketrift.insights WHERE tenant_id = %s",
                             (tenant_b,)).fetchone()[0] == 0

    async def invalid_evidence(_body):
        return {"issues": [{"category": "billing", "sentiment": "negative", "severity": "high",
                            "description": "A cobrança foi duplicada no mês.",
                            "evidence_quote": "A cobrança nunca aconteceu"}]}

    monkeypatch.setattr(analysis_module, "extract_review", invalid_evidence)
    with pytest.raises(RuntimeError, match="InvalidEvidence"):
        run(job_b)

    async def malformed(_body):
        return {"issues": [{"category": "unknown", "description": "Resposta incompleta"}]}

    monkeypatch.setattr(analysis_module, "extract_review", malformed)
    with pytest.raises(RuntimeError, match="ValidationError"):
        run(job_b)
    with psycopg.connect(os.environ["TEST_DATABASE_ADMIN_URL"]) as admin:
        assert admin.execute("SELECT count(*) FROM marketrift.insights WHERE tenant_id = %s",
                             (tenant_b,)).fetchone()[0] == 0

    monkeypatch.setattr(analysis_module, "extract_review", extract_review)
    assert run(job_b)["issues"] == 1
    with psycopg.connect(os.environ["TEST_DATABASE_ADMIN_URL"]) as admin:
        assert admin.execute("SELECT attempt_count FROM marketrift.document_analyses "
                             "WHERE tenant_id = %s AND document_id = %s", (tenant_b, document_b)).fetchone()[0] == 5

    new_version = "review-issues-v2"
    monkeypatch.setenv("EXTRACTOR_VERSION", new_version)
    with psycopg.connect(os.environ["TEST_DATABASE_ADMIN_URL"]) as admin:
        admin.execute("INSERT INTO marketrift.document_analyses "
                      "(tenant_id, document_id, extractor_version) VALUES (%s, %s, %s)",
                      (tenant_a, document_a, new_version))
    assert run(make_analysis_job(tenant_a, document_a, new_version))["issues"] == 2
    with psycopg.connect(os.environ["TEST_DATABASE_ADMIN_URL"]) as admin:
        assert admin.execute("SELECT count(*) FROM marketrift.document_analyses "
                             "WHERE tenant_id = %s AND document_id = %s", (tenant_a, document_a)).fetchone()[0] == 2
