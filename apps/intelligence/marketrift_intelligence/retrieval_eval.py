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


def vector_rank(question: str, documents: list[dict], vectors: list[list[float]]) -> list[tuple[str, float]]:
    query = embed(question)
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
                               "expected_ids": sorted(expected - hits), "retrieved_ids": top})
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
