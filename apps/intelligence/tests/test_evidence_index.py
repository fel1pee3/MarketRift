from datetime import UTC, datetime, timedelta

import pytest

from marketrift_intelligence.embeddings import DIMENSIONS, embed, identity
from marketrift_intelligence.evidence_index import chunks, eligible_document


def row(kind="b2b_review", synthetic=False, status="declared_real", enabled=True,
        source="b2b_csv_review", storage=True, reference="contract", expires=None,
        environment="production"):
    return ("id", kind, "body", synthetic, status, enabled, source, storage,
            reference, expires, environment)


def test_controlled_embedding_is_deterministic_and_test_only(monkeypatch):
    monkeypatch.setenv("EMBEDDING_PROVIDER", "controlled")
    assert identity()[0].endswith("TESTE")
    assert len(embed("falha de cobrança")) == DIMENSIONS
    assert embed("falha de cobrança") == embed("falha de cobrança")
    assert embed("falha de cobrança") != embed("bom suporte")


def test_local_mode_fails_clearly_without_pinned_weights(monkeypatch, tmp_path):
    monkeypatch.setenv("EMBEDDING_PROVIDER", "local")
    monkeypatch.setenv("EMBEDDING_MODEL_PATH", str(tmp_path / "absent"))
    with pytest.raises(RuntimeError, match="local_embedding_model_missing"):
        embed("suporte demorou")


def test_chunks_are_literal_and_bounded():
    text = "Primeira frase.\n" + "falha na exportação de faturas " * 100
    result = chunks(text)
    assert len(result) > 1
    assert all(part in text and len(part) <= 480 for part in result)
    with pytest.raises(ValueError, match="content_chunk_limit_exceeded"):
        chunks("palavra " * 10000)


def test_eligibility_is_explicit():
    assert eligible_document(row())
    assert eligible_document(row(expires=datetime.now(UTC) + timedelta(days=1)))
    assert not eligible_document(row(expires=datetime.now(UTC) - timedelta(days=1)))
    assert not eligible_document(row(storage=False))
    assert not eligible_document(row(reference=None))
    assert not eligible_document(row(enabled=False))
    assert not eligible_document(row(kind="g2_review", source="g2"))
    assert eligible_document(row(synthetic=True, status="synthetic_fixture"))
    assert not eligible_document(row(synthetic=True, status="declared_real"))
    assert eligible_document(row(kind="github_discussion", source="github_discussions"))
    assert not eligible_document(row(kind="steam_review", source="steam_reviews"))
