"""The browser workspace calls the existing quality evaluator through the internal service."""

from uuid import uuid4

from fastapi.testclient import TestClient

from marketrift_intelligence.http import app


def dataset():
    tenant, source, document = uuid4(), uuid4(), uuid4()
    text = "Exemplo sintético: a exportação de faturas falhou duas vezes."
    return {"schema_version": "review-quality-dataset-v2", "dataset_id": f"b2b-{uuid4()}",
            "version": "1.0.0", "examples": [{
                "id": f"b2b-{uuid4()}", "synthetic": True, "case_type": "complaint", "text": text,
                "source": {"kind": "b2b_csv", "name": "B2B CSV", "url": "https://example.invalid/reviews/1",
                           "published_at": "2026-09-01", "language": None, "tenant_id": str(tenant),
                           "source_id": str(source), "document_id": str(document), "external_key": "test-1"},
                "labeler": f"human:{uuid4()}", "rights_basis": "Synthetic test source",
                "gold": {"decision": "problem", "issues": [{"category": "features", "severity": "medium",
                    "evidence_quote": "a exportação de faturas falhou duas vezes"}]},
            }]}


def test_internal_quality_reuses_controlled_extractor_without_paid_call(monkeypatch):
    monkeypatch.setenv("EMBEDDING_INTERNAL_TOKEN", "test-internal-token")
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    client = TestClient(app)
    body = {"dataset": dataset(), "settings": {"provider": "test", "model": "controlled-test-fixture-v1",
            "max_examples": 1, "max_output_tokens": 512}}
    assert client.post("/internal/b2b-quality/evaluate", json=body).status_code == 401
    response = client.post("/internal/b2b-quality/evaluate", json=body,
                           headers={"X-Internal-Token": "test-internal-token"})
    assert response.status_code == 200
    report = response.json()
    assert report["metrics"]["scored_synthetic_examples"] == 1
    assert report["metrics"]["scored_real_examples"] == 0
    assert report["metrics"]["categories"]["features"]["tp"] == 1
    assert report["run"]["api_calls_attempted"] == 0
    assert "text" not in str(report)


def test_internal_quality_blocks_real_controlled_and_paid_without_credential(monkeypatch):
    monkeypatch.setenv("EMBEDDING_INTERNAL_TOKEN", "test-internal-token")
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    client = TestClient(app)
    real = dataset()
    real["examples"][0]["synthetic"] = False
    body = {"dataset": real, "settings": {"provider": "test", "model": "controlled-test-fixture-v1",
            "max_examples": 1, "max_output_tokens": 512}}
    response = client.post("/internal/b2b-quality/evaluate", json=body,
                           headers={"X-Internal-Token": "test-internal-token"})
    assert response.status_code == 400
    body["settings"] = {"provider": "openai", "model": "gpt-5-nano", "allow_paid": True,
                        "max_examples": 1, "max_output_tokens": 256,
                        "budget_usd": 0.05, "input_usd_per_million": 1, "output_usd_per_million": 4}
    assert client.post("/internal/b2b-quality/evaluate", json=body,
                       headers={"X-Internal-Token": "test-internal-token"}).status_code == 400
