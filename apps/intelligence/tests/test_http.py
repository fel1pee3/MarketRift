from fastapi.testclient import TestClient

from marketrift_intelligence.http import app


def test_health():
    response = TestClient(app).get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
