import json
from pathlib import Path

import pytest

from marketrift_intelligence.retrieval_eval import evaluate, metrics, validate

FIXTURE = Path(__file__).resolve().parents[3] / "evalsets" / "retrieval.synthetic.v1.json"


def test_metrics_count_relevance_and_no_answer_separately():
    questions = [{"id": "hit", "relevant_ids": ["a", "b"]},
                 {"id": "miss", "relevant_ids": ["c"]},
                 {"id": "none", "relevant_ids": []}]
    rankings = {"hit": [("x", 0.9), ("b", 0.8), ("a", 0.7)],
                "miss": [("x", 0.9), ("a", 0.8)], "none": [("x", 0.1)]}
    result = metrics(questions, rankings, 2, 0.15)
    assert result["recall_at_k"] == 0.25
    assert result["mrr_at_k"] == 0.25
    assert result["no_answer_correct"] == 1
    assert result["false_positive_items"] == 3
    assert result["false_negative_items"] == 2
    assert any(error["question_id"] == "miss" for error in result["errors"])


def test_synthetic_eval_uses_controlled_pipeline_and_never_claims_real_quality():
    dataset = json.loads(FIXTURE.read_text(encoding="utf-8"))
    report = evaluate(dataset, "controlled", 3)
    assert report["origin"] == "synthetic"
    assert report["human_real_questions"] == 0
    assert report["external_cost_usd"] == 0
    assert set(report["runs"]) == {"controlled", "literal"}
    assert report["runs"]["controlled"]["metrics"]["questions"] == 6


def test_real_labels_must_cover_all_candidates_and_keep_permission_basis():
    dataset = json.loads(FIXTURE.read_text(encoding="utf-8"))
    dataset["origin"] = "real"
    with pytest.raises(ValueError, match="reviewer"):
        validate(dataset)
    dataset["reviewer"] = "human"
    dataset["permission_basis"] = "local authorization reference"
    with pytest.raises(ValueError, match="incomplete_human_judgments"):
        validate(dataset)
    dataset["questions"][0]["relevant_ids"] = ["invented"]
    with pytest.raises(ValueError, match="invalid_relevant_id"):
        validate(dataset)
