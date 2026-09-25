from fastapi.testclient import TestClient

from marketrift_intelligence.http import app


def test_health():
    response = TestClient(app).get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_internal_embedding_requires_private_token(monkeypatch):
    monkeypatch.setenv("EMBEDDING_PROVIDER", "controlled")
    monkeypatch.setenv("EMBEDDING_INTERNAL_TOKEN", "test-only-internal-token")
    client = TestClient(app)
    assert client.post("/internal/embeddings", json={"text": "suporte"}).status_code == 401
    response = client.post("/internal/embeddings", json={"text": "suporte"},
                           headers={"X-Internal-Token": "test-only-internal-token"})
    assert response.status_code == 200
    assert response.json()["dimensions"] == 384
    assert response.json()["test_only"] is True
    status = client.get("/internal/embeddings/status",
                        headers={"X-Internal-Token": "test-only-internal-token"})
    assert status.status_code == 200
    assert status.json()["model"] == "controlled-hash-TESTE"
    assert client.get("/internal/embeddings/status").status_code == 401


def test_local_status_reports_missing_weights_without_controlled_fallback(monkeypatch, tmp_path):
    monkeypatch.setenv("EMBEDDING_PROVIDER", "local")
    monkeypatch.setenv("EMBEDDING_MODEL_PATH", str(tmp_path / "absent"))
    monkeypatch.setenv("EMBEDDING_INTERNAL_TOKEN", "test-only-internal-token")
    response = TestClient(app).get("/internal/embeddings/status",
                                   headers={"X-Internal-Token": "test-only-internal-token"})
    assert response.status_code == 503
    assert response.json()["detail"].startswith("local_embedding_model_missing")
