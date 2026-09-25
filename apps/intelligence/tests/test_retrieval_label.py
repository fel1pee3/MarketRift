import json

import pytest

from marketrift_intelligence import retrieval_label


def test_private_path_and_resume_without_prediction(tmp_path, monkeypatch):
    monkeypatch.setattr(retrieval_label, "PRIVATE_ROOT", tmp_path)
    path = retrieval_label.private_path(str(tmp_path / "review.json"))
    with pytest.raises(ValueError, match="private_dataset"):
        retrieval_label.private_path(str(tmp_path.parent / "outside.json"))
    dataset = {"reviewer": "", "permission_basis": "", "documents": [
        {"id": "a", "source_type": "b2b_review", "text": "texto A"},
        {"id": "b", "source_type": "b2b_review", "text": "texto B"}], "questions": []}
    retrieval_label.save(path, dataset)
    answers = iter(["revisor", "autorização local", "Pergunta humana", "s", ""])
    monkeypatch.setattr("builtins.input", lambda _: next(answers))
    retrieval_label.label(path)
    partial = json.loads(path.read_text(encoding="utf-8"))
    assert partial["questions"][0]["judged_ids"] == ["a"]
    assert partial["questions"][0]["relevant_ids"] == ["a"]
    answers = iter(["n", ""])
    monkeypatch.setattr("builtins.input", lambda _: next(answers))
    retrieval_label.label(path)
    resumed = json.loads(path.read_text(encoding="utf-8"))
    assert resumed["questions"][0]["judged_ids"] == ["a", "b"]
    assert resumed["questions"][0]["relevant_ids"] == ["a"]
