"""PostgreSQL/RLS B2B rights checks. All documents are disposable test fixtures."""

import asyncio
import os
from uuid import UUID, uuid4

import psycopg
import pytest

import marketrift_intelligence.analyze as module
from marketrift_intelligence.analysis_job import make_analysis_job
from marketrift_intelligence.b2b_eval import extract_with_current_rights
from marketrift_intelligence.extract import EXTRACTOR_VERSION
from marketrift_intelligence.quality_eval import EvalExample, GoldIssue, GoldLabel, Source

pytestmark = pytest.mark.skipif(
    not (os.getenv("TEST_DATABASE_ADMIN_URL") and os.getenv("RUNTIME_DATABASE_URL")),
    reason="requires migrated PostgreSQL",
)


def run(job):
    if os.name == "nt":
        return asyncio.run(module.analyze(job), loop_factory=asyncio.SelectorEventLoop)
    return asyncio.run(module.analyze(job))


def test_b2b_rights_rechecked_at_worker_and_replay_is_idempotent(request, monkeypatch):
    tenant, other = str(uuid4()), str(uuid4())
    source_ids = {}
    document_ids = {}
    calls = []
    monkeypatch.setenv("B2B_PAID_ANALYSIS_ENABLED", "1")
    monkeypatch.setenv("ANALYSIS_MODEL", "gpt-5-nano")
    monkeypatch.setenv("B2B_INPUT_USD_PER_MILLION", "1")
    monkeypatch.setenv("B2B_OUTPUT_USD_PER_MILLION", "1")
    monkeypatch.setattr(module, "provider_available", lambda *_args, **_kwargs: True)

    async def controlled_provider(body, **_kwargs):
        calls.append(body)
        return {"issues": [{"category": "billing", "sentiment": "negative",
                            "severity": "medium", "description": "Falha de cobrança.",
                            "evidence_quote": "falha de cobrança"}]}

    monkeypatch.setattr(module, "extract_review", controlled_provider)

    def cleanup():
        with psycopg.connect(os.environ["TEST_DATABASE_ADMIN_URL"]) as admin:
            for table in ("insights", "document_analyses", "documents", "sources", "products"):
                admin.execute(f"DELETE FROM marketrift.{table} WHERE tenant_id IN (%s, %s)",
                              (tenant, other))
            admin.execute("DELETE FROM marketrift.tenants WHERE id IN (%s, %s)", (tenant, other))

    request.addfinalizer(cleanup)
    with psycopg.connect(os.environ["TEST_DATABASE_ADMIN_URL"]) as admin:
        for company in (tenant, other):
            product = str(uuid4())
            admin.execute("INSERT INTO marketrift.tenants (id, name) VALUES (%s, 'b2b-security-test')",
                          (company,))
            admin.execute("INSERT INTO marketrift.products (id, tenant_id, name, kind) "
                          "VALUES (%s, %s, 'Disposable fixture', 'competitor')", (product, company))
            if company == other:
                continue
            for scenario in ("storage_only", "active", "revoked", "expired"):
                source, document = str(uuid4()), str(uuid4())
                source_ids[scenario], document_ids[scenario] = source, document
                active = scenario in ("active", "revoked", "expired")
                admin.execute(
                    "INSERT INTO marketrift.sources (id, tenant_id, product_id, source_type, url, "
                    "access_environment, rights_reference, storage_permitted, external_ai_permitted, "
                    "ai_provider, ai_rights_reference, ai_rights_attested_at, ai_rights_expires_at) "
                    "VALUES (%s, %s, %s, 'b2b_csv_review', %s, "
                    "'production', 'disposable-test-storage-basis', true, %s, %s, %s, now(), "
                    "now() + interval '1 day')",
                    (source, tenant, product, f"https://authorized-vendor.io/reviews/{scenario}",
                     active, "openai" if active else None,
                     "disposable-test-ai-basis" if active else None),
                )
                admin.execute(
                    "INSERT INTO marketrift.documents "
                    "(id, tenant_id, source_id, document_type, external_key, source_url, body, "
                    "synthetic, review_data_status) VALUES (%s, %s, %s, 'b2b_review', %s, "
                    "'https://authorized-vendor.io/reviews/fixture', "
                    "'TESTE DESCARTÁVEL: falha de cobrança', false, 'declared_real')",
                    (document, tenant, source, scenario),
                )
                admin.execute(
                    "INSERT INTO marketrift.document_analyses "
                    "(tenant_id, document_id, extractor_version, requested_provider, requested_model, "
                    "max_output_tokens, budget_usd, paid_approved_at) "
                    "VALUES (%s, %s, %s, 'openai', 'gpt-5-nano', 128, 0.05, now())",
                    (tenant, document, EXTRACTOR_VERSION),
                )
        admin.execute("UPDATE marketrift.sources SET external_ai_permitted = false, "
                      "ai_rights_revoked_at = now() WHERE id = %s", (source_ids["revoked"],))
        admin.execute("UPDATE marketrift.sources SET ai_rights_expires_at = now() - interval '1 day' "
                      "WHERE id = %s", (source_ids["expired"],))

    for scenario in ("storage_only", "revoked", "expired"):
        job = make_analysis_job(tenant, document_ids[scenario], EXTRACTOR_VERSION)
        assert run(job)["status"] == "unavailable"
    assert calls == []
    with pytest.raises(ValueError, match="does not belong"):
        run(make_analysis_job(other, document_ids["active"], EXTRACTOR_VERSION))
    job = make_analysis_job(tenant, document_ids["active"], EXTRACTOR_VERSION)
    assert run(job)["issues"] == 1
    assert run(job) == {"status": "completed", "replayed": True}
    assert len(calls) == 1
    with psycopg.connect(os.environ["TEST_DATABASE_ADMIN_URL"]) as admin:
        assert admin.execute("SELECT count(*) FROM marketrift.insights "
                             "WHERE tenant_id = %s AND document_id = %s",
                             (tenant, document_ids["active"])).fetchone()[0] == 1
        assert admin.execute("SELECT count(*) FROM marketrift.insights "
                             "WHERE tenant_id = %s AND document_id IN (%s, %s, %s)",
                             (tenant, document_ids["storage_only"], document_ids["revoked"],
                              document_ids["expired"])).fetchone()[0] == 0

    def example(scenario, company=tenant):
        return EvalExample(id=f"b2b-{scenario.replace('_', '-')}", synthetic=False, case_type="complaint",
                           text="TESTE DESCARTÁVEL: falha de cobrança",
                           source=Source(kind="b2b_csv", tenant_id=UUID(company),
                                         source_id=UUID(source_ids[scenario]), document_id=UUID(document_ids[scenario]),
                                         external_key=scenario),
                           labeler="human:test", rights_basis="Disposable fixture for security test",
                           gold=GoldLabel(decision="problem", issues=[GoldIssue(
                               category="billing", evidence_quote="falha de cobrança")]))

    eval_calls = []

    async def fake_eval(body):
        eval_calls.append(body)
        return {"issues": []}

    def check_eval(scope):
        coroutine = extract_with_current_rights(scope, fake_eval)
        if os.name == "nt":
            return asyncio.run(coroutine, loop_factory=asyncio.SelectorEventLoop)
        return asyncio.run(coroutine)

    for scenario in ("storage_only", "revoked", "expired"):
        with pytest.raises(PermissionError):
            check_eval(example(scenario))
    with pytest.raises(PermissionError):
        check_eval(example("active", other))
    assert eval_calls == []
    assert check_eval(example("active")) == {"issues": []}
    assert len(eval_calls) == 1

    invalid_doc = str(uuid4())
    with psycopg.connect(os.environ["TEST_DATABASE_ADMIN_URL"]) as admin:
        admin.execute("INSERT INTO marketrift.documents "
                      "(id, tenant_id, source_id, document_type, external_key, source_url, body, "
                      "synthetic, review_data_status) VALUES (%s, %s, %s, 'b2b_review', 'invalid-evidence', "
                      "'https://authorized-vendor.io/reviews/invalid-evidence', "
                      "'TESTE DESCARTÁVEL: falha de cobrança', false, 'declared_real')",
                      (invalid_doc, tenant, source_ids["active"]))
        admin.execute("INSERT INTO marketrift.document_analyses "
                      "(tenant_id, document_id, extractor_version, requested_provider, requested_model, "
                      "max_output_tokens, budget_usd, paid_approved_at) "
                      "VALUES (%s, %s, %s, 'openai', 'gpt-5-nano', 128, 0.05, now())",
                      (tenant, invalid_doc, EXTRACTOR_VERSION))

    async def invented_quote(_body, **_kwargs):
        return {"issues": [{"category": "billing", "sentiment": "negative",
                            "severity": "medium", "description": "Falha de cobrança.",
                            "evidence_quote": "a cobrança foi duplicada ontem"}]}

    monkeypatch.setattr(module, "extract_review", invented_quote)
    with pytest.raises(RuntimeError, match="InvalidEvidence"):
        run(make_analysis_job(tenant, invalid_doc, EXTRACTOR_VERSION))
    with psycopg.connect(os.environ["TEST_DATABASE_ADMIN_URL"]) as admin:
        assert admin.execute("SELECT count(*) FROM marketrift.insights WHERE document_id = %s",
                             (invalid_doc,)).fetchone()[0] == 0


def test_synthetic_b2b_forces_controlled_fixture_even_with_openai_configured(request, monkeypatch):
    tenant, product, source, document = (str(uuid4()) for _ in range(4))

    def cleanup():
        with psycopg.connect(os.environ["TEST_DATABASE_ADMIN_URL"]) as admin:
            for table in ("insights", "document_analyses", "documents", "sources", "products"):
                admin.execute(f"DELETE FROM marketrift.{table} WHERE tenant_id = %s", (tenant,))
            admin.execute("DELETE FROM marketrift.tenants WHERE id = %s", (tenant,))

    request.addfinalizer(cleanup)
    with psycopg.connect(os.environ["TEST_DATABASE_ADMIN_URL"]) as admin:
        admin.execute("INSERT INTO marketrift.tenants (id, name) VALUES (%s, 'synthetic-b2b-test')", (tenant,))
        admin.execute("INSERT INTO marketrift.products (id, tenant_id, name, kind) "
                      "VALUES (%s, %s, 'Disposable fixture', 'competitor')", (product, tenant))
        admin.execute("INSERT INTO marketrift.sources "
                      "(id, tenant_id, product_id, source_type, url, access_environment, "
                      "access_status, rights_reference, storage_permitted) "
                      "VALUES (%s, %s, %s, 'b2b_csv_review', 'https://example.invalid/b2b-reviews', "
                      "'sandbox', 'sandbox_only', 'disposable-test-storage-basis', true)",
                      (source, tenant, product))
        admin.execute("INSERT INTO marketrift.documents "
                      "(id, tenant_id, source_id, document_type, external_key, source_url, body, "
                      "synthetic, review_data_status) "
                      "VALUES (%s, %s, %s, 'b2b_review', 'fixture', 'https://example.invalid/reviews/fixture', "
                      "'Exemplo sintético: a exportação de faturas falhou duas vezes.', "
                      "true, 'synthetic_fixture')", (document, tenant, source))
        admin.execute("INSERT INTO marketrift.document_analyses "
                      "(tenant_id, document_id, extractor_version, requested_provider, requested_model) "
                      "VALUES (%s, %s, %s, 'test', 'controlled-test-fixture-v1')",
                      (tenant, document, EXTRACTOR_VERSION))
    monkeypatch.setenv("ANALYSIS_PROVIDER", "openai")
    monkeypatch.delenv("MARKETRIFT_TEST_MODE", raising=False)
    assert run(make_analysis_job(tenant, document, EXTRACTOR_VERSION))["issues"] == 1
    with psycopg.connect(os.environ["TEST_DATABASE_ADMIN_URL"]) as admin:
        assert admin.execute("SELECT model_id FROM marketrift.document_analyses "
                             "WHERE tenant_id = %s AND document_id = %s",
                             (tenant, document)).fetchone()[0] == "controlled-test-fixture-v1"
