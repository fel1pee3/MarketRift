"""Prepare and manually label private B2B CSV reviews, without model calls."""

import argparse
import os
from pathlib import Path
from uuid import UUID

import psycopg
from pydantic import ValidationError

from .b2b_eval import (
    DEFAULT_DATASET, DEFAULT_PROGRESS, DEFAULT_SAMPLE, B2BItem, B2BProgress, B2BSample,
    item_digest, item_id, labeled_dataset, load_progress, load_sample, select_items,
)
from .quality_eval import GoldIssue, GoldLabel, load_dataset
from .steam_eval import LabelEntry, private_path, write_json_atomic
from .steam_eval_cli import StopLabeling, _ask, _choice


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Private B2B review sampling and human labels; no AI")
    sub = parser.add_subparsers(dest="command", required=True)
    sources = sub.add_parser("sources", help="Show source IDs and eligible counts, never text")
    sources.add_argument("--tenant-id", type=UUID, help="Optional local tenant filter")
    sample = sub.add_parser("sample", help="Select eligible local documents")
    sample.add_argument("--tenant-id", type=UUID, required=True)
    sample.add_argument("--source-id", type=UUID, required=True)
    sample.add_argument("--synthetic", action="store_true", help="Select test fixtures, not real reviews")
    sample.add_argument("--limit", type=int, default=30)
    sample.add_argument("--output", type=Path, default=DEFAULT_SAMPLE)
    sample.add_argument("--progress", type=Path, default=DEFAULT_PROGRESS)
    label = sub.add_parser("label", help="Label one review at a time, saving after each")
    label.add_argument("--sample", type=Path, default=DEFAULT_SAMPLE)
    label.add_argument("--progress", type=Path, default=DEFAULT_PROGRESS)
    label.add_argument("--dataset", type=Path, default=DEFAULT_DATASET)
    label.add_argument("--labeler", help="human:your-name")
    label.add_argument("--rights-basis", help="Documented basis for this private evaluation")
    label.add_argument("--max-items", type=int, default=None)
    validate = sub.add_parser("validate", help="Validate private labels and export")
    validate.add_argument("--sample", type=Path, default=DEFAULT_SAMPLE)
    validate.add_argument("--progress", type=Path, default=DEFAULT_PROGRESS)
    validate.add_argument("--dataset", type=Path, default=DEFAULT_DATASET)
    return parser.parse_args(argv)


def _source_condition(synthetic: bool) -> str:
    if synthetic:
        return "s.access_environment = 'sandbox' AND d.synthetic AND d.review_data_status = 'synthetic_fixture'"
    return ("s.access_environment = 'production' AND s.external_ai_permitted "
            "AND s.ai_provider = 'openai' AND s.ai_rights_reference IS NOT NULL "
            "AND s.ai_rights_expires_at > now() AND s.ai_rights_revoked_at IS NULL "
            "AND NOT d.synthetic AND d.review_data_status = 'declared_real'")


def candidates(tenant_id: UUID, source_id: UUID, synthetic: bool) -> list[B2BItem]:
    # Use the runtime role and transaction-local RLS context, even in this local tool.
    with psycopg.connect(os.environ["RUNTIME_DATABASE_URL"]) as connection:
        connection.execute("SELECT set_config('app.tenant_id', %s, true)", (str(tenant_id),))
        rows = connection.execute(
            "SELECT d.id, d.external_key, d.body, d.source_url, d.published_at, d.review_language "
            "FROM marketrift.documents d JOIN marketrift.sources s ON s.tenant_id = d.tenant_id "
            "AND s.id = d.source_id WHERE d.tenant_id = %s AND d.source_id = %s "
            "AND d.document_type = 'b2b_review' AND s.source_type = 'b2b_csv_review' "
            "AND s.enabled AND s.storage_permitted AND " + _source_condition(synthetic) +
            " ORDER BY d.published_at DESC NULLS LAST, d.id LIMIT 500", (tenant_id, source_id),
        ).fetchall()
    result = []
    for document_id, key, body, url, date, language in rows:
        if body and body.strip() and len(body) <= 10000:
            result.append(B2BItem(id=item_id(source_id, key), tenant_id=tenant_id, source_id=source_id,
                                  document_id=document_id, external_key=key, text=body, source_url=url,
                                  published_at=date, language=language, synthetic=synthetic,
                                  review_data_status="synthetic_fixture" if synthetic else "declared_real"))
    return result


def list_sources(tenant_id: UUID | None) -> None:
    database_url = os.environ["RUNTIME_DATABASE_URL"] if tenant_id else os.environ["DATABASE_ADMIN_URL"]
    with psycopg.connect(database_url) as connection:
        if tenant_id:
            connection.execute("SELECT set_config('app.tenant_id', %s, true)", (str(tenant_id),))
        rows = connection.execute(
            "SELECT s.tenant_id, s.id, s.access_environment, count(d.id) FILTER (WHERE d.synthetic), "
            "count(d.id) FILTER (WHERE NOT d.synthetic), s.storage_permitted, "
            "(s.external_ai_permitted AND s.ai_provider = 'openai' "
            "AND s.ai_rights_expires_at > now() AND s.ai_rights_revoked_at IS NULL) "
            "FROM marketrift.sources s LEFT JOIN marketrift.documents d "
            "ON d.tenant_id = s.tenant_id AND d.source_id = s.id "
            "WHERE (%s::uuid IS NULL OR s.tenant_id = %s) AND s.source_type = 'b2b_csv_review' "
            "GROUP BY s.tenant_id, s.id ORDER BY s.tenant_id, s.id", (tenant_id, tenant_id),
        ).fetchall()
    for row in rows:
        print(f"tenant_id={row[0]} source_id={row[1]} environment={row[2]} "
              f"synthetic={row[3]} real={row[4]} storage={row[5]} external_ai_current={row[6]}")


def sample_reviews(args: argparse.Namespace) -> None:
    if not 1 <= args.limit <= 50:
        raise ValueError("--limit must be 1-50")
    output, progress_path = private_path(args.output), private_path(args.progress)
    existing = load_sample(output) if output.exists() else None
    if existing and (existing.tenant_id, existing.source_id, existing.synthetic) != (
            args.tenant_id, args.source_id, args.synthetic):
        raise ValueError("existing sample has another scope; use new private paths")
    if progress_path.exists() and existing is None:
        raise ValueError("label progress exists without its sample")
    items = select_items(candidates(args.tenant_id, args.source_id, args.synthetic),
                         args.limit, existing.items if existing else None)
    sample = B2BSample(dataset_id=existing.dataset_id if existing else
                       f"b2b-{str(args.source_id).replace('-', '')[:16]}-{'synthetic' if args.synthetic else 'real'}",
                       version=existing.version if existing else "1.0.0", tenant_id=args.tenant_id,
                       source_id=args.source_id, synthetic=args.synthetic, items=items)
    if progress_path.exists():
        labeled_dataset(sample, load_progress(progress_path))
    write_json_atomic(output, sample)
    print(f"Private sample: {len(items)}/{args.limit}; real={0 if args.synthetic else len(items)}; "
          f"synthetic={len(items) if args.synthetic else 0}; no model calls.")


def human_label(item: B2BItem) -> LabelEntry:
    print("\n" + "=" * 72)
    print(f"Review {item.id} | {item.published_at or 'data ausente'} | "
          f"{'SINTÉTICA' if item.synthetic else 'real declarada'}")
    print(f"Origem: {item.source_url}")
    print("Nenhuma previsão da IA será mostrada. Texto original:\n" + item.text + "\n")
    decision = _choice("Problema concreto? [p] sim [n] não [i] evidência insuficiente [q] sair: ",
                       ("p", "n", "i"))
    if decision == "n":
        case_type = "positive" if _choice("[p] positivo [n] neutro: ", ("p", "n")) == "p" else "neutral"
        gold = GoldLabel(decision="no_problem", issues=[])
    elif decision == "i":
        case_type, gold = "ambiguous", GoldLabel(decision="insufficient_evidence", issues=[])
    else:
        categories = {"1": "support", "2": "price", "3": "billing", "4": "performance",
                      "5": "usability", "6": "features", "o": "out_of_taxonomy"}
        issues = []
        while len(issues) < 8:
            category = categories[_choice(
                "Categoria [1] suporte [2] preço [3] cobrança [4] desempenho [5] usabilidade "
                "[6] funcionalidades [o] fora da taxonomia: ", tuple(categories))]
            topic = _ask("Tema fora da taxonomia: ") if category == "out_of_taxonomy" else None
            while True:
                quote = _ask("Trecho LITERAL do texto que comprova o problema: ")
                if 3 <= len(quote) <= 500 and quote in item.text:
                    break
                print("O trecho deve ter 3-500 caracteres e aparecer literalmente no texto.")
            severity = _choice("Gravidade [b] baixa [m] média [a] alta [?] sem evidência: ",
                               ("b", "m", "a", "?"))
            issues.append(GoldIssue(category=category, outside_topic=topic or None,
                                    severity={"b": "low", "m": "medium", "a": "high", "?": None}[severity],
                                    evidence_quote=quote))
            if len(issues) == 8 or _choice("Outro problema? [s] sim [n] não: ", ("s", "n")) == "n":
                break
        case_type, gold = "complaint", GoldLabel(decision="problem", issues=issues)
    return LabelEntry(review_sha256=item_digest(item), case_type=case_type, gold=gold)


def label(args: argparse.Namespace) -> None:
    if args.max_items is not None and not 1 <= args.max_items <= 50:
        raise ValueError("--max-items must be 1-50")
    sample_path, progress_path, dataset_path = map(private_path,
                                                   (args.sample, args.progress, args.dataset))
    sample = load_sample(sample_path)
    if progress_path.exists():
        progress = load_progress(progress_path)
        if args.labeler and args.labeler != progress.labeler:
            raise ValueError("labeler differs from saved progress")
        if args.rights_basis and args.rights_basis != progress.rights_basis:
            raise ValueError("rights basis differs from saved progress")
    else:
        if dataset_path.exists() or not args.labeler or not args.rights_basis:
            raise ValueError("first run needs reviewer and rights basis; existing export needs progress")
        progress = B2BProgress(dataset_id=sample.dataset_id, version=sample.version,
                               tenant_id=sample.tenant_id, source_id=sample.source_id,
                               labeler=args.labeler, rights_basis=args.rights_basis)
    labeled_dataset(sample, progress)
    if progress.labels:
        write_json_atomic(dataset_path, labeled_dataset(sample, progress))
    saved = 0
    try:
        for item in sample.items:
            if item.id in progress.labels or (args.max_items is not None and saved >= args.max_items):
                continue
            while True:
                try:
                    entry = human_label(item)
                    updated = progress.model_copy(deep=True)
                    updated.labels[item.id] = entry
                    dataset = labeled_dataset(sample, updated)
                    break
                except (ValueError, ValidationError):
                    print("Rótulo inválido; tente novamente ou q para sair.")
            write_json_atomic(progress_path, updated)
            write_json_atomic(dataset_path, dataset)
            progress, saved = updated, saved + 1
            print(f"Rótulos humanos salvos: {len(progress.labels)}/{len(sample.items)}")
    except (StopLabeling, KeyboardInterrupt, EOFError):
        print("Interrompido; os rótulos salvos serão retomados na próxima execução.")
    print(f"Rotuladas={len(progress.labels)}; restantes={len(sample.items)-len(progress.labels)}")


def validate(args: argparse.Namespace) -> None:
    sample_path, progress_path, dataset_path = map(private_path,
                                                   (args.sample, args.progress, args.dataset))
    sample = load_sample(sample_path)
    if not progress_path.exists():
        if dataset_path.exists():
            raise ValueError("evaluation export exists without human label progress")
        print(f"Amostra válida: {len(sample.items)}; rótulos humanos=0")
        return
    progress = load_progress(progress_path)
    expected = labeled_dataset(sample, progress)
    if progress.labels and load_dataset(dataset_path)[0].model_dump(mode="json") != expected.model_dump(mode="json"):
        raise ValueError("export differs from saved human labels")
    print(f"Amostra válida: {len(sample.items)}; rótulos humanos={len(progress.labels)}; "
          f"reais rotulados={0 if sample.synthetic else len(progress.labels)}")


def main(argv: list[str] | None = None) -> None:
    args = parse_args(argv)
    try:
        if args.command == "sources":
            list_sources(args.tenant_id)
        elif args.command == "sample":
            sample_reviews(args)
        elif args.command == "label":
            label(args)
        else:
            validate(args)
    except (ValueError, ValidationError, OSError, psycopg.Error, KeyError) as error:
        # Database and validation errors can contain text. Only expose type.
        raise SystemExit(f"B2B evaluation command failed ({type(error).__name__})") from None


if __name__ == "__main__":
    main()
