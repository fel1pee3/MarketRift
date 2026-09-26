import pytest

from marketrift_intelligence import retrieval_eval


def fixture():
    return {"version": "public-github.v1", "origin": "real", "index_version": retrieval_eval.INDEX_VERSION,
            "corpus_hash": "c" * 64, "judgment_hash": "j" * 64,
            "documents": [
                {"id": "a", "source_type": "github_issue", "text": "Support failed"},
                {"id": "b", "source_type": "github_discussion", "text": "Pricing changed"},
                {"id": "c", "source_type": "github_issue", "text": "Other topic"}],
            "questions": [
                {"id": "q1", "text": "support", "language": "en", "judged_ids": ["a", "b", "c"],
                 "relevant_ids": ["a"], "no_answer_claim": False},
                {"id": "q2", "text": "unknown", "language": "en", "judged_ids": ["a", "b", "c"],
                 "relevant_ids": [], "no_answer_claim": True},
                {"id": "q3", "text": "price", "language": "en", "judged_ids": ["b"],
                 "relevant_ids": ["b"], "no_answer_claim": False}]}


def test_frozen_eval_separates_complete_partial_and_no_answer(monkeypatch):
    vector = {"Support failed": [1.0, 0.0], "Pricing changed": [0.0, 1.0],
              "Other topic": [-1.0, 0.0], "support": [1.0, 0.0],
              "unknown": [0.0, 0.0], "price": [0.0, 1.0]}
    monkeypatch.setattr(retrieval_eval, "embed", lambda text, provider=None: vector[text])
    report = retrieval_eval.evaluate_frozen(fixture())
    assert report["corpus_size"] == 3 and report["fully_judged_questions"] == 2
    assert report["judged_pairs"] == 7 and report["external_cost_usd"] == 0
    local = report["runs"]["local"]["metrics"]
    assert local["at_3"]["complete"]["recall_at_k"] == 1.0
    assert local["at_5"]["complete"]["mrr_at_k"] == 1.0
    assert local["at_5"]["complete"]["no_answer_correct"] == 1
    assert local["at_3"]["conditional_judged_only"]["answerable_questions"] == 1
    assert local["at_3"]["conditional_judged_only"]["unjudged_in_top"] == []
    assert report["runs"]["controlled"]["model"] == "controlled-hash-TESTE"


def test_frozen_eval_rejects_invalid_or_unreviewed_no_answer():
    data = fixture()
    data["questions"][0]["relevant_ids"] = ["outside"]
    with pytest.raises(ValueError, match="invalid_frozen_judgments"):
        retrieval_eval.evaluate_frozen(data)
    data = fixture()
    data["questions"][1]["no_answer_claim"] = False
    with pytest.raises(ValueError, match="invalid_frozen_judgments"):
        retrieval_eval.evaluate_frozen(data)
    data = fixture()
    data["documents"][0]["source_type"] = "b2b_review"
    with pytest.raises(ValueError, match="invalid_public_item"):
        retrieval_eval.evaluate_frozen(data)
