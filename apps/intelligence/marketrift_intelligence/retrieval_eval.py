"""Small, offline retrieval evaluation using the same embed() as the worker."""
import argparse
import json
import os
import re
import time
import unicodedata
from pathlib import Path

from .embeddings import embed, identity

INDEX_VERSION = "evidence_chunks/013/exact-cosine/chunks-v1"
FROZEN_EVALUATOR_VERSION = "frozen-ranking-v2"
FROZEN_CONTRACT_VERSION = "frozen-eval-contract-v2"


def validate(dataset: dict) -> None:
    if dataset.get("index_version") != INDEX_VERSION or dataset.get("origin") not in ("synthetic", "real"):
        raise ValueError("invalid_dataset_version_or_origin")
    documents = dataset.get("documents", [])
    questions = dataset.get("questions", [])
    ids = {item["id"] for item in documents}
    if not documents or not questions or len(ids) != len(documents):
        raise ValueError("empty_or_duplicate_dataset")
    if dataset["origin"] == "real" and (not dataset.get("reviewer") or not dataset.get("permission_basis")):
        raise ValueError("real_dataset_needs_reviewer_and_permission_basis")
    for question in questions:
        if not set(question.get("relevant_ids", [])).issubset(ids):
            raise ValueError(f"invalid_relevant_id:{question['id']}")
        if dataset["origin"] == "real" and set(question.get("judged_ids", [])) != ids:
            raise ValueError(f"incomplete_human_judgments:{question['id']}")


def tokens(text: str) -> set[str]:
    clean = unicodedata.normalize("NFKD", text.casefold())
    clean = "".join(char for char in clean if not unicodedata.combining(char))
    return set(re.findall(r"\w+", clean))


def literal_rank(question: str, documents: list[dict]) -> list[tuple[str, float]]:
    words = tokens(question)
    scores = [(item["id"], len(words & tokens(item["text"])) / max(1, len(words))) for item in documents]
    return sorted(scores, key=lambda row: (-row[1], row[0]))


def vector_rank(question: str, documents: list[dict], vectors: list[list[float]],
                provider: str | None = None) -> list[tuple[str, float]]:
    query = embed(question, provider) if provider else embed(question)
    scores = [(item["id"], sum(a * b for a, b in zip(query, vector, strict=True)))
              for item, vector in zip(documents, vectors, strict=True)]
    return sorted(scores, key=lambda row: (-row[1], row[0]))


def metrics(questions: list[dict], rankings: dict[str, list[tuple[str, float]]], k: int,
            minimum_score: float) -> dict:
    answerable = [question for question in questions if question["relevant_ids"]]
    unanswered = [question for question in questions if not question["relevant_ids"]]
    recall = reciprocal = 0.0
    errors = []
    no_answer_correct = 0
    false_positives = false_negatives = 0
    for question in questions:
        expected = set(question["relevant_ids"])
        top = [item for item, score in rankings[question["id"]][:k] if score >= minimum_score]
        if expected:
            hits = expected.intersection(top)
            recall += len(hits) / len(expected)
            false_negatives += len(expected - hits)
            wrong = [item for item in top if item not in expected]
            false_positives += len(wrong)
            if wrong:
                errors.append({"question_id": question["id"], "kind": "non_relevant_retrieved",
                               "retrieved_ids": wrong})
            if hits:
                reciprocal += 1 / (1 + min(top.index(item) for item in hits))
            if expected - hits:
                errors.append({"question_id": question["id"], "kind": "missed_relevance",
                               "expected_ids": sorted(expected - hits)})
        elif not top:
            no_answer_correct += 1
        else:
            false_positives += len(top)
            errors.append({"question_id": question["id"], "kind": "answer_without_labeled_evidence",
                           "retrieved_ids": top})
    return {"questions": len(questions), "answerable": len(answerable), "without_answer": len(unanswered),
            "recall_at_k": recall / len(answerable) if answerable else None,
            "mrr_at_k": reciprocal / len(answerable) if answerable else None,
            "no_answer_correct": no_answer_correct, "false_positive_items": false_positives,
            "false_negative_items": false_negatives, "errors": errors}


def evaluate(dataset: dict, provider: str, k: int) -> dict:
    validate(dataset)
    original = os.environ.get("EMBEDDING_PROVIDER")
    result = {"dataset_version": dataset["version"], "origin": dataset["origin"],
              "index_version": INDEX_VERSION, "question_count": len(dataset["questions"]),
              "human_real_questions": len(dataset["questions"]) if dataset["origin"] == "real" else 0,
              "k": k, "external_cost_usd": 0, "runs": {}}
    try:
        for mode in dict.fromkeys((provider, "controlled")):
            os.environ["EMBEDDING_PROVIDER"] = mode
            started = time.perf_counter()
            first = embed(dataset["documents"][0]["text"])
            cold_ms = round((time.perf_counter() - started) * 1000)
            started = time.perf_counter()
            embed(dataset["documents"][0]["text"])
            warm_ms = round((time.perf_counter() - started) * 1000)
            vectors = [first] + [embed(item["text"]) for item in dataset["documents"][1:]]
            rankings = {q["id"]: vector_rank(q["text"], dataset["documents"], vectors)
                        for q in dataset["questions"]}
            model, version = identity()
            result["runs"][mode] = {"model": model, "model_version": version,
                                    "cold_ms": cold_ms, "warm_ms": warm_ms,
                                    "metrics": metrics(dataset["questions"], rankings, k, 0.15),
                                    "ranked_ids": {key: [item for item, _ in value[:k]]
                                                   for key, value in rankings.items()}}
    finally:
        if original is None:
            os.environ.pop("EMBEDDING_PROVIDER", None)
        else:
            os.environ["EMBEDDING_PROVIDER"] = original
    rankings = {q["id"]: literal_rank(q["text"], dataset["documents"]) for q in dataset["questions"]}
    result["runs"]["literal"] = {"model": "literal-token-overlap", "model_version": "1",
                                  "metrics": metrics(dataset["questions"], rankings, k, 0.000001),
                                  "ranked_ids": {key: [item for item, _ in value[:k]]
                                                 for key, value in rankings.items()}}
    return result


def evaluate_frozen(dataset: dict, providers: tuple[str, ...] = ("local", "controlled")) -> dict:
    """Blind judgments of a frozen public GitHub corpus. Never treats unjudged as negative."""
    documents = dataset.get("documents", [])
    questions = dataset.get("questions", [])
    ids = [item.get("id") for item in documents]
    question_ids = [item.get("id") for item in questions]
    if (not isinstance(dataset.get("set_id"), str) or not dataset["set_id"] or
            dataset.get("origin") not in ("real", "synthetic") or dataset.get("index_version") != INDEX_VERSION or
            not 1 <= len(documents) <= 30 or not 1 <= len(questions) <= 20 or len(ids) != len(set(ids)) or
            len(question_ids) != len(set(question_ids)) or not all(isinstance(item, str) and item for item in ids) or
            not all(isinstance(item, str) and item for item in question_ids) or
            not re.fullmatch(r"public-github\.v[1-9]\d*", str(dataset.get("version", ""))) or
            not all(re.fullmatch(r"[a-f0-9]{64}", str(dataset.get(key, "")))
                    for key in ("corpus_hash", "judgment_hash"))):
        raise ValueError("invalid_frozen_corpus")
    for item in documents:
        if (item.get("source_type") not in ("github_issue", "github_discussion") or
                not isinstance(item.get("text"), str) or not 1 <= len(item["text"]) <= 12000):
            raise ValueError("invalid_public_item")
    for question in questions:
        judged = question.get("judged_ids", [])
        relevant = question.get("relevant_ids", [])
        if (not isinstance(question.get("text"), str) or not 3 <= len(question["text"]) <= 500 or
                question.get("language") not in ("pt", "en") or len(judged) != len(set(judged)) or
                not set(relevant).issubset(judged) or not set(judged).issubset(ids) or
                (question.get("no_answer_claim") and relevant) or
                (set(judged) == set(ids) and not relevant and not question.get("no_answer_claim"))):
            raise ValueError("invalid_frozen_judgments")

    result = {"contract_version": FROZEN_CONTRACT_VERSION, "evaluator_version": FROZEN_EVALUATOR_VERSION,
              "set_id": dataset["set_id"], "dataset_version": dataset["version"],
              "origin": "public_github_real" if dataset["origin"] == "real" else "synthetic_test",
              "index_version": INDEX_VERSION, "corpus_hash": dataset["corpus_hash"],
              "judgment_hash": dataset["judgment_hash"], "corpus_size": len(documents),
              "question_count": len(questions), "document_ids": ids, "question_ids": question_ids,
              "labels_by_question": {q["id"]: {"judged_ids": q["judged_ids"],
                                                "relevant_ids": q["relevant_ids"]} for q in questions},
              "human_judged_questions": sum(bool(q["judged_ids"]) for q in questions),
              "fully_judged_questions": sum(len(q["judged_ids"]) == len(ids) for q in questions),
              "judged_pairs": sum(len(q["judged_ids"]) for q in questions),
              "total_pairs": len(ids) * len(questions),
              "languages": {language: sum(q["language"] == language for q in questions)
                            for language in ("pt", "en")},
              "source_types": {source: sum(d["source_type"] == source for d in documents)
                               for source in ("github_issue", "github_discussion")},
              "external_cost_usd": 0, "runs": {}}
    for provider in providers:
        started = time.perf_counter()
        first = embed(documents[0]["text"], provider)
        cold_ms = round((time.perf_counter() - started) * 1000)
        started = time.perf_counter()
        embed(documents[0]["text"], provider)
        warm_ms = round((time.perf_counter() - started) * 1000)
        started = time.perf_counter()
        vectors = [first] + [embed(item["text"], provider) for item in documents[1:]]
        rankings = {q["id"]: vector_rank(q["text"], documents, vectors, provider) for q in questions}
        model, version = identity(provider)
        coverage = ranking_coverage(questions, rankings, ids)
        result["runs"][provider] = {"model": model, "model_version": version,
                                      "cold_ms": cold_ms, "warm_ms": warm_ms,
                                      "elapsed_ms": round((time.perf_counter() - started) * 1000),
                                      "metrics": judged_metrics(questions, rankings, len(ids)),
                                      "ranking_coverage": coverage,
                                      "abstention_at_5": abstention_diagnostics(questions, rankings, len(ids), 0.15),
                                      "ranked_ids": {q: [item for item, _ in rows[:5]]
                                                     for q, rows in rankings.items()}}
    started = time.perf_counter()
    rankings = {q["id"]: literal_rank(q["text"], documents) for q in questions}
    coverage = ranking_coverage(questions, rankings, ids)
    result["runs"]["literal"] = {"model": "literal-token-overlap", "model_version": "1",
                                   "elapsed_ms": round((time.perf_counter() - started) * 1000),
                                   "metrics": judged_metrics(questions, rankings, len(ids)),
                                   "ranking_coverage": coverage,
                                   "abstention_at_5": abstention_diagnostics(questions, rankings, len(ids), 0.000001),
                                   "ranked_ids": {q: [item for item, _ in rows[:5]]
                                                  for q, rows in rankings.items()}}
    result["rankings_directly_comparable"] = all(
        entry["ranked_count"] == entry["eligible_count"]
        for run in result["runs"].values() for entry in run["ranking_coverage"].values())
    return result


def ranking_coverage(questions: list[dict], rankings: dict[str, list[tuple[str, float]]],
                     eligible_ids: list[str], exclusions: dict[str, dict[str, str]] | None = None) -> dict:
    """Every eligible item must be ranked or carry an explicit exclusion reason."""
    eligible = set(eligible_ids)
    coverage = {}
    for question in questions:
        question_id = question["id"]
        rows = rankings.get(question_id)
        if rows is None:
            raise ValueError("missing_question_ranking")
        ranked = [item_id for item_id, _ in rows]
        omitted = (exclusions or {}).get(question_id, {})
        if (len(ranked) != len(set(ranked)) or not set(ranked).issubset(eligible) or
                set(omitted) != eligible - set(ranked) or
                any(not isinstance(reason, str) or not reason.strip() for reason in omitted.values())):
            raise ValueError("incomplete_ranking_without_exclusion_reason")
        coverage[question_id] = {"eligible_count": len(eligible), "ranked_count": len(ranked),
                                 "excluded": [{"item_id": item_id, "reason": omitted[item_id]}
                                              for item_id in eligible_ids if item_id in omitted]}
    return coverage


def abstention_diagnostics(questions: list[dict], rankings: dict[str, list[tuple[str, float]]],
                           corpus_size: int, minimum_score: float) -> dict:
    """A score cutoff is an abstention experiment, not part of Recall@k/MRR@k."""
    per_question = {}
    without_answer = correct = 0
    for question in questions:
        top = rankings[question["id"]][:5]
        returned = [item_id for item_id, score in top if score >= minimum_score]
        per_question[question["id"]] = {
            "ranked_count": len(rankings[question["id"]]), "returned_ids": returned,
            "excluded": [{"item_id": item_id, "reason": "below_abstention_threshold", "score": score}
                         for item_id, score in top if score < minimum_score]}
        if len(question["judged_ids"]) == corpus_size and question["no_answer_claim"]:
            without_answer += 1
            correct += not returned
    return {"minimum_score": minimum_score, "without_answer": without_answer,
            "correct_no_answer": correct, "per_question": per_question,
            "comparable_across_models": False}


def judged_metrics(questions: list[dict], rankings: dict[str, list[tuple[str, float]]],
                   corpus_size: int) -> dict:
    """Rank-only metrics; no score cutoff may remove an eligible top-k candidate."""
    complete = [q for q in questions if len(q["judged_ids"]) == corpus_size]
    incomplete = [q for q in questions if len(q["judged_ids"]) < corpus_size]
    output = {}
    for k in (3, 5):
        answerable = [q for q in complete if q["relevant_ids"]]
        full = metrics(answerable, rankings, k, float("-inf")) if complete else None
        if full is not None:
            full["questions"] = len(complete)
            full["without_answer"] = len(complete) - len(answerable)
            full["no_answer_correct"] = None  # Reported only in the separate abstention diagnostic.
        partial_recall = partial_reciprocal = 0.0
        partial_answerable = 0
        unjudged_top = []
        judged_irrelevant_top = []
        for q in incomplete:
            top = [item for item, _ in rankings[q["id"]][:k]]
            known = set(q["judged_ids"])
            positives = set(q["relevant_ids"])
            unjudged_top.extend({"question_id": q["id"], "item_id": item}
                                for item in top if item not in known)
            judged_irrelevant_top.extend({"question_id": q["id"], "item_id": item}
                                        for item in top if item in known - positives)
            if positives:
                partial_answerable += 1
                hits = positives.intersection(top)
                partial_recall += len(hits) / len(positives)
                if hits:
                    partial_reciprocal += 1 / (1 + min(top.index(item) for item in hits))
        output[f"at_{k}"] = {"complete": full,
                             "conditional_judged_only": {
                                 "answerable_questions": partial_answerable,
                                 "recall": partial_recall / partial_answerable if partial_answerable else None,
                                 "mrr": partial_reciprocal / partial_answerable if partial_answerable else None,
                                 "unjudged_in_top": unjudged_top,
                                 "judged_irrelevant_in_top": judged_irrelevant_top}}
    return output


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", default="evalsets/retrieval.synthetic.v1.json")
    parser.add_argument("--provider", choices=["local", "controlled"], default="controlled")
    parser.add_argument("--k", type=int, choices=range(1, 11), default=3)
    parser.add_argument("--output", default=".tmp/retrieval-report.json")
    args = parser.parse_args()
    result = evaluate(json.loads(Path(args.dataset).read_text(encoding="utf-8")), args.provider, args.k)
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"{result['origin']}: {result['question_count']} questions, {result['human_real_questions']} human real; "
          f"external USD 0; report {output}")
    for mode, run in result["runs"].items():
        values = run["metrics"]
        print(f"{mode}: recall@{args.k}={values['recall_at_k']} mrr@{args.k}={values['mrr_at_k']} "
              f"no_answer={values['no_answer_correct']}/{values['without_answer']}; "
              f"fp_items={values['false_positive_items']} fn_items={values['false_negative_items']} "
              f"errors={len(values['errors'])}")


if __name__ == "__main__":
    main()
