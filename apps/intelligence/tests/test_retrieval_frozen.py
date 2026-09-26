import pytest

from marketrift_intelligence import retrieval_eval


def fixture():
    return {"set_id": "e8f28408-d57b-4839-989b-f519550c8e0d", "version": "public-github.v1",
            "origin": "real", "index_version": retrieval_eval.INDEX_VERSION,
            "corpus_hash": "c" * 64, "judgment_hash": "a" * 64,
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
    assert report["runs"]["local"]["abstention_at_5"]["correct_no_answer"] == 1
    assert local["at_3"]["conditional_judged_only"]["answerable_questions"] == 1
    assert {item["item_id"] for item in local["at_3"]["conditional_judged_only"]["unjudged_in_top"]} == {"a", "c"}
    assert report["runs"]["controlled"]["model"] == "controlled-hash-TESTE"
    assert report["evaluator_version"] == retrieval_eval.FROZEN_EVALUATOR_VERSION
    assert report["contract_version"] == retrieval_eval.FROZEN_CONTRACT_VERSION
    assert report["set_id"] == fixture()["set_id"]
    assert report["document_ids"] == ["a", "b", "c"]
    assert report["question_ids"] == ["q1", "q2", "q3"]
    assert report["labels_by_question"]["q1"] == {"judged_ids": ["a", "b", "c"],
                                                    "relevant_ids": ["a"]}
    assert report["rankings_directly_comparable"] is True


def test_five_eligible_one_relevant_must_have_full_recall_without_score_cutoff():
    ids = [f"item-{n}" for n in range(5)]
    question = {"id": "q", "judged_ids": ids, "relevant_ids": [ids[1]], "no_answer_claim": False}
    rankings = {"q": [(ids[0], 0.17), (ids[1], 0.12), (ids[2], 0.11),
                      (ids[3], 0.10), (ids[4], 0.02)]}
    coverage = retrieval_eval.ranking_coverage([question], rankings, ids)
    assert coverage["q"] == {"eligible_count": 5, "ranked_count": 5, "excluded": []}
    values = retrieval_eval.judged_metrics([question], rankings, 5)
    assert values["at_5"]["complete"]["recall_at_k"] == 1.0
    assert values["at_5"]["complete"]["mrr_at_k"] == 0.5
    assert values["at_5"]["complete"]["false_negative_items"] == 0
    assert values["at_3"]["complete"]["recall_at_k"] == 1.0
    cutoff = retrieval_eval.abstention_diagnostics([question], rankings, 5, 0.15)
    assert cutoff["per_question"]["q"]["returned_ids"] == [ids[0]]
    assert cutoff["per_question"]["q"]["excluded"][0] == {
        "item_id": ids[1], "reason": "below_abstention_threshold", "score": 0.12}


def test_missed_relevance_names_only_human_relevant_item():
    ids = [f"item-{n}" for n in range(5)]
    question = {"id": "q", "judged_ids": ids, "relevant_ids": [ids[4]], "no_answer_claim": False}
    rankings = {"q": [(item, 0.9 - index * 0.1) for index, item in enumerate(ids)]}
    errors = retrieval_eval.judged_metrics([question], rankings, 5)["at_3"]["complete"]["errors"]
    missed = [item for item in errors if item["kind"] == "missed_relevance"]
    assert missed == [{"question_id": "q", "kind": "missed_relevance", "expected_ids": [ids[4]]}]


def test_partial_ranking_requires_explicit_exclusion_reason():
    ids = [f"item-{n}" for n in range(5)]
    questions = [{"id": "q"}]
    rankings = {"q": [(item, 1.0) for item in ids[:-1]]}
    with pytest.raises(ValueError, match="incomplete_ranking_without_exclusion_reason"):
        retrieval_eval.ranking_coverage(questions, rankings, ids)
    coverage = retrieval_eval.ranking_coverage(questions, rankings, ids,
                                               {"q": {ids[-1]: "source_revoked"}})
    assert coverage["q"] == {"eligible_count": 5, "ranked_count": 4,
                              "excluded": [{"item_id": ids[-1], "reason": "source_revoked"}]}


def test_response_echoes_exact_input_order_and_labels(monkeypatch):
    vectors = {"Support failed": [1.0, 0.0], "Pricing changed": [0.0, 1.0],
               "Other topic": [-1.0, 0.0], "support": [1.0, 0.0],
               "unknown": [0.0, 0.0], "price": [0.0, 1.0]}
    monkeypatch.setattr(retrieval_eval, "embed", lambda text, provider=None: vectors[text])
    data = fixture()
    data["documents"].reverse()
    data["questions"][0]["judged_ids"].reverse()
    report = retrieval_eval.evaluate_frozen(data, providers=("controlled",))
    assert report["document_ids"] == ["c", "b", "a"]
    assert report["labels_by_question"]["q1"]["judged_ids"] == ["c", "b", "a"]
    assert report["corpus_hash"] == data["corpus_hash"]
    assert report["judgment_hash"] == data["judgment_hash"]


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
    data = fixture()
    data["version"] = "public-github.v2"
    data["questions"][1]["id"] = data["questions"][0]["id"]
    with pytest.raises(ValueError, match="invalid_frozen_corpus"):
        retrieval_eval.evaluate_frozen(data)
    data = fixture()
    data.pop("set_id")
    with pytest.raises(ValueError, match="invalid_frozen_corpus"):
        retrieval_eval.evaluate_frozen(data)
