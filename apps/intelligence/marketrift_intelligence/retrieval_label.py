"""Private local sample and blind human relevance judgments; never calls a model."""
import argparse
import json
import os
from pathlib import Path
from uuid import UUID, uuid4

import psycopg

from .embeddings import identity
from .retrieval_eval import INDEX_VERSION

PRIVATE_ROOT = Path("evalsets/private").resolve()


def private_path(value: str) -> Path:
    path = Path(value).resolve()
    if not path.is_relative_to(PRIVATE_ROOT):
        raise ValueError("private_dataset_must_stay_in_evalsets/private")
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


def save(path: Path, dataset: dict) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(dataset, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(path)


def sample(tenant_id: str, source_id: str, limit: int, output: Path) -> int:
    if output.exists():
        raise ValueError("private_sample_exists: choose another output to preserve judgments")
    UUID(tenant_id)
    UUID(source_id)
    if not 1 <= limit <= 30:
        raise ValueError("sample_limit_must_be_1_to_30")
    model, version = identity()
    with psycopg.connect(os.environ["RUNTIME_DATABASE_URL"]) as connection, connection.transaction():
        connection.execute("SELECT set_config('app.tenant_id', %s, true)", (tenant_id,))
        rows = connection.execute("""SELECT e.id, e.source_type, e.text_content,
                coalesce(d.source_url, ss.final_url) AS source_url
              FROM marketrift.evidence_chunks e
              JOIN marketrift.sources s ON s.tenant_id = e.tenant_id AND s.id = e.source_id
              LEFT JOIN marketrift.documents d ON d.tenant_id = e.tenant_id AND d.id = e.document_id
              LEFT JOIN marketrift.source_snapshots ss ON ss.tenant_id = e.tenant_id AND ss.id = e.snapshot_id
              WHERE e.source_id = %s AND e.embedding_model = %s AND e.embedding_version = %s
                AND e.status = 'ready' AND NOT e.synthetic AND s.enabled
                AND ((d.id IS NOT NULL AND e.content_version = md5(d.body)
                  AND strpos(d.body, e.text_content) > 0 AND
                  ((d.document_type = 'github_issue' AND s.source_type = 'github_issues')
                   OR (d.document_type = 'github_discussion' AND s.source_type = 'github_discussions')
                   OR (d.document_type = 'b2b_review' AND s.source_type = 'b2b_csv_review'
                     AND d.review_data_status = 'declared_real' AND s.storage_permitted
                     AND s.rights_reference IS NOT NULL AND s.access_environment = 'production'
                     AND (s.rights_expires_at IS NULL OR s.rights_expires_at > now()))))
                 OR (ss.id IS NOT NULL AND e.content_version = md5(ss.normalized_text)
                   AND strpos(ss.normalized_text, e.text_content) > 0
                   AND s.source_type IN ('pricing_page', 'release_notes')
                   AND ss.interpretation_version >= 2 AND ss.interpretation_status = 'confirmed'))
              ORDER BY e.indexed_at DESC, e.id LIMIT %s""", (source_id, model, version, limit)).fetchall()
    dataset = {"version": "retrieval.real.private.v1", "origin": "real", "index_version": INDEX_VERSION,
               "source_id": source_id, "model": model, "model_version": version,
               "reviewer": "", "permission_basis": "", "documents": [
                   {"id": str(item_id), "source_type": source_type, "text": text,
                    "source_url": source_url, "synthetic": False}
                   for item_id, source_type, text, source_url in rows], "questions": []}
    save(output, dataset)
    return len(rows)


def label(path: Path) -> None:
    dataset = json.loads(path.read_text(encoding="utf-8"))
    if not dataset.get("reviewer"):
        dataset["reviewer"] = input("Revisor humano: ").strip()
    if not dataset.get("permission_basis"):
        dataset["permission_basis"] = input("Referência da permissão de uso local: ").strip()
    if not dataset["reviewer"] or not dataset["permission_basis"]:
        raise ValueError("reviewer_and_permission_basis_required")
    save(path, dataset)
    while True:
        incomplete = next((question for question in dataset["questions"] if
                           len(question.get("judged_ids", [])) < len(dataset["documents"])), None)
        if incomplete is None:
            text = input("Nova pergunta (Enter para sair): ").strip()
            if not text:
                break
            incomplete = {"id": str(uuid4()), "text": text, "relevant_ids": [], "judged_ids": []}
            dataset["questions"].append(incomplete)
            save(path, dataset)
        print(f"Pergunta: {incomplete['text']}")
        for document in dataset["documents"]:
            if document["id"] in incomplete["judged_ids"]:
                continue
            print(f"ID {document['id']} · {document['source_type']} · {document.get('source_url', '')}")
            print(document["text"])
            answer = input("Evidência relevante? [s/n/Enter para interromper]: ").strip().lower()
            if answer not in ("s", "n"):
                save(path, dataset)
                return
            incomplete["judged_ids"].append(document["id"])
            if answer == "s":
                incomplete["relevant_ids"].append(document["id"])
            save(path, dataset)


def main() -> None:
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest="command", required=True)
    sampling = commands.add_parser("sample")
    sampling.add_argument("--tenant-id", required=True)
    sampling.add_argument("--source-id", required=True)
    sampling.add_argument("--limit", type=int, default=20)
    sampling.add_argument("--output", default="evalsets/private/retrieval-real.v1.json")
    labeling = commands.add_parser("label")
    labeling.add_argument("--dataset", default="evalsets/private/retrieval-real.v1.json")
    args = parser.parse_args()
    if args.command == "sample":
        count = sample(args.tenant_id, args.source_id, args.limit, private_path(args.output))
        print(f"Private sample saved: {count} eligible chunks; no model call")
    else:
        label(private_path(args.dataset))


if __name__ == "__main__":
    main()
