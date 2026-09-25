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
