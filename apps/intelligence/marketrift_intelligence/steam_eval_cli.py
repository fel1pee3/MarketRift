"""Prepare and manually label private Steam reviews without calling an AI provider."""

import argparse
import asyncio
import os
from datetime import UTC, datetime
from pathlib import Path
from uuid import UUID

import httpx
import psycopg
from pydantic import ValidationError

from .quality_eval import GoldIssue, GoldLabel, load_dataset
from .steam_eval import (
    DEFAULT_DATASET,
    DEFAULT_PROGRESS,
    DEFAULT_SAMPLE,
    LabelEntry,
    LabelProgress,
    SteamSample,
    from_database_row,
    from_steam_review,
    label_counts,
    labeled_dataset,
    load_progress,
    load_sample,
    private_path,
    review_digest,
    sample_counts,
    select_sample,
    validate_progress,
    write_json_atomic,
)
from .steam_reviews import SteamCollectionError, fetch_reviews


class StopLabeling(Exception):
    pass


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Local Steam review sampling and human labeling; no AI calls")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("sources", help="List tenant/App ID pairs with locally collected reviews (no text)")
    sample = sub.add_parser("sample", help="Build or extend a private sample without labeling")
    sample.add_argument("--tenant-id", type=UUID, help="Required if more than one tenant matches")
    sample.add_argument("--app-id", type=int, help="Required if more than one App ID matches")
    sample.add_argument("--limit", type=int, default=30, help="Target sample size, 1-50")
    sample.add_argument("--fetch-missing", action="store_true", help="Explicitly allow a small Steam API read")
    sample.add_argument("--balance-negative", action="store_true",
                        help="Before labeling, fetch at most 20 negative recommendations and rebalance")
    sample.add_argument("--max-pages", type=int, default=2, help="Maximum Steam API pages, 1-3")
    sample.add_argument("--output", type=Path, default=DEFAULT_SAMPLE)
    sample.add_argument("--progress", type=Path, default=DEFAULT_PROGRESS,
                        help="Human-label progress to protect from rebalancing after labeling")
    label = sub.add_parser("label", help="Show one review at a time and save human labels after each")
    label.add_argument("--sample", type=Path, default=DEFAULT_SAMPLE)
    label.add_argument("--progress", type=Path, default=DEFAULT_PROGRESS)
    label.add_argument("--dataset", type=Path, default=DEFAULT_DATASET)
    label.add_argument("--labeler", help="Human identifier, e.g. human:felipe")
    label.add_argument("--rights-basis", help="Your documented basis to store/send these texts")
    label.add_argument("--max-items", type=int, default=None, help="Stop after this many new human labels")
    label.add_argument("--edit", help="Relabel one sample ID previously labeled")
    validate = sub.add_parser("validate", help="Validate sample, saved labels and evaluation dataset")
    validate.add_argument("--sample", type=Path, default=DEFAULT_SAMPLE)
    validate.add_argument("--progress", type=Path, default=DEFAULT_PROGRESS)
    validate.add_argument("--dataset", type=Path, default=DEFAULT_DATASET)
    return parser.parse_args(argv)


def source_pairs() -> list[tuple[str, int, int, int]]:
    if not os.getenv("DATABASE_ADMIN_URL"):
        raise ValueError("DATABASE_ADMIN_URL is required for local sampling")
    with psycopg.connect(os.environ["DATABASE_ADMIN_URL"]) as connection:
        return connection.execute(
            "SELECT tenant_id::text, steam_app_id::integer, count(*)::integer, "
            "count(DISTINCT external_key)::integer FROM marketrift.documents "
            "WHERE document_type = 'steam_review' AND synthetic = false "
            "GROUP BY tenant_id, steam_app_id ORDER BY tenant_id, steam_app_id"
        ).fetchall()


def choose_scope(pairs: list[tuple[str, int, int, int]], tenant_id: UUID | None,
                 app_id: int | None) -> tuple[UUID, int]:
    matching = {(UUID(tenant), app) for tenant, app, _, _ in pairs
                if (tenant_id is None or UUID(tenant) == tenant_id) and (app_id is None or app == app_id)}
    if len(matching) != 1:
        raise ValueError("select exactly one tenant and App ID shown by `sources`")
    return matching.pop()


def database_candidates(tenant_id: UUID, app_id: int) -> tuple[list, int]:
    with psycopg.connect(os.environ["DATABASE_ADMIN_URL"]) as connection:
        rows = connection.execute(
            "SELECT d.external_key, d.body, d.review_language, d.source_created_at, "
            "d.source_updated_at, d.review_voted_up, d.source_url FROM marketrift.documents d "
            "JOIN marketrift.sources s ON s.tenant_id = d.tenant_id AND s.id = d.source_id "
            "WHERE d.tenant_id = %s AND d.steam_app_id = %s AND d.document_type = 'steam_review' "
            "AND d.synthetic = false AND s.source_type = 'steam_reviews' "
            "ORDER BY d.source_updated_at DESC, d.id LIMIT 500", (tenant_id, app_id),
        ).fetchall()
    candidates = []
    skipped = 0
    for row in rows:
        if not row[1] or not row[1].strip() or len(row[1]) > 10000:
            skipped += 1
            continue
        candidates.append(from_database_row(app_id, row))
    return candidates, skipped


async def prepare(args: argparse.Namespace) -> None:
    if not 1 <= args.limit <= 50 or not 1 <= args.max_pages <= 3:
        raise ValueError("limits are 1-50 reviews and 1-3 pages")
    output = private_path(args.output)
    tenant_id, app_id = choose_scope(source_pairs(), args.tenant_id, args.app_id)
    existing = load_sample(output) if output.exists() else None
    if existing and (existing.tenant_id != tenant_id or existing.app_id != app_id):
        raise ValueError("existing sample belongs to another tenant or App ID")
    if args.balance_negative and not existing:
        raise ValueError("prepare an initial sample before balancing negative recommendations")
    progress_path = private_path(args.progress)
    if args.balance_negative and progress_path.exists() and load_progress(progress_path).labels:
        raise ValueError("cannot rebalance after human labeling has started")
    candidates, skipped = database_candidates(tenant_id, app_id)
    before = len(candidates)
    if args.balance_negative and existing:
        candidates.extend(existing.items)
    fetched = pages = 0
    fetch_error = None
    should_fetch = args.balance_negative or (args.fetch_missing and len(select_sample(
        candidates, args.limit, existing.items if existing else [])) < args.limit)
    if should_fetch:
        try:
            async with httpx.AsyncClient(timeout=10, follow_redirects=False) as client:
                reviews, fetched, pages, _, _, _ = await fetch_reviews(
                    app_id, None, args.max_pages, 20 if args.balance_negative else 50, client,
                    review_type="negative" if args.balance_negative else "all")
            for review in reviews:
                if review.review.strip() and len(review.review) <= 10000:
                    candidates.append(from_steam_review(app_id, review))
                else:
                    skipped += 1
        except SteamCollectionError as error:
            fetch_error = error.code
    kept = existing.items if existing and (not args.balance_negative or fetch_error) else []
    selected = select_sample(candidates, args.limit, kept)
    sample = SteamSample(dataset_id=f"steam-reviews-{app_id}-real", version="1.0.0",
                         tenant_id=tenant_id, app_id=app_id,
                         created_at=existing.created_at if existing else datetime.now(UTC), items=selected)
    write_json_atomic(output, sample)
    summary = sample_counts(sample.items)
    print(f"Sample saved privately: {summary['total']}/{args.limit}; existing DB candidates={before}; "
          f"Steam API received={fetched} in {pages} pages; skipped empty/too long={skipped}.")
    print(f"Recommendation balance: positive={summary['positive_recommendations']}, "
          f"negative={summary['negative_recommendations']}; lengths: short={summary['short']}, "
          f"medium={summary['medium']}, long={summary['long']}.")
    print("These are sampling strata, not human problem labels. No AI was called.")
    if fetch_error:
        print(f"Steam API read failed ({fetch_error}); saved the locally available reviews only.")
    if len(selected) < args.limit:
        print(f"Shortfall: {args.limit - len(selected)} unique reviews. A later explicit small collection can extend the sample.")


def _ask(prompt: str) -> str:
    answer = input(prompt).strip()
    if answer.lower() in ("q", "quit"):
        raise StopLabeling
    return answer


def _choice(prompt: str, allowed: tuple[str, ...]) -> str:
    while True:
        answer = _ask(prompt).lower()
        if answer in allowed:
            return answer
        print("Opção inválida; escolha uma das opções mostradas ou q para sair.")


def _human_label(item) -> LabelEntry:
    print("\n" + "=" * 72)
    print(f"Review {item.id} | App ID {item.app_id} | idioma {item.language} | "
          f"criada {item.created_at.isoformat()}")
    print(f"Origem: {item.source_url} (página do produto, não permalink individual)")
    print("O voto de recomendação fica oculto aqui para reduzir viés. Nenhuma previsão de IA é mostrada.")
    print("Texto original:\n" + item.text + "\n")
    decision = _choice("Problema concreto? [p] sim, [n] não, [i] evidência insuficiente, [q] sair: ",
                       ("p", "n", "i"))
    if decision == "n":
        case_type = _choice("O texto é [p] positivo ou [n] neutro? ", ("p", "n"))
        return LabelEntry(review_sha256=review_digest(item),
                          case_type="positive" if case_type == "p" else "neutral",
                          gold=GoldLabel(decision="no_problem", issues=[]))
    if decision == "i":
        return LabelEntry(review_sha256=review_digest(item), case_type="ambiguous",
                          gold=GoldLabel(decision="insufficient_evidence", issues=[]))
    issues = []
    categories = {"1": "support", "2": "price", "3": "billing", "4": "performance",
                  "5": "usability", "6": "features", "o": "out_of_taxonomy"}
    while len(issues) < 8:
        category = categories[_choice(
            "Categoria [1] suporte [2] preço [3] cobrança [4] desempenho [5] usabilidade "
            "[6] funcionalidades [o] fora da taxonomia: ", tuple(categories))]
        topic = _ask("Tema fora da taxonomia (opcional): ") if category == "out_of_taxonomy" else None
        while True:
            quote = _ask("Copie um trecho LITERAL e contínuo do texto que comprove este problema: ")
            if 3 <= len(quote) <= 500 and quote in item.text:
                break
            print("Trecho inválido: use de 3 a 500 caracteres que apareçam exatamente no texto.")
        severity = _choice("Gravidade baseada somente no texto [b] baixa [m] média [a] alta "
                           "[?] sem evidência para graduar: ", ("b", "m", "a", "?"))
        issues.append(GoldIssue(category=category, evidence_quote=quote,
                                severity={"b": "low", "m": "medium", "a": "high", "?": None}[severity],
                                outside_topic=topic or None))
        if len(issues) == 8 or _choice("Outro problema neste mesmo texto? [s] sim [n] não: ", ("s", "n")) == "n":
            break
    return LabelEntry(review_sha256=review_digest(item), case_type="complaint",
                      gold=GoldLabel(decision="problem", issues=issues))


def label(args: argparse.Namespace) -> None:
    if args.max_items is not None and not 1 <= args.max_items <= 50:
        raise ValueError("--max-items must be between 1 and 50")
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
        if dataset_path.exists():
            raise ValueError("evaluation dataset exists without label progress; recover progress before labeling")
        if not args.labeler or not args.rights_basis:
            raise ValueError("first labeling run requires --labeler and --rights-basis")
        progress = LabelProgress(dataset_id=sample.dataset_id, version=sample.version,
                                 tenant_id=sample.tenant_id, app_id=sample.app_id,
                                 labeler=args.labeler, rights_basis=args.rights_basis,
                                 labels={})
    validate_progress(sample, progress)
    # A process can stop after saving progress and before writing the derived dataset.
    # Progress is the authoritative human record; rebuild the export on resume.
    if progress.labels:
        write_json_atomic(dataset_path, labeled_dataset(sample, progress))
    if args.edit:
        if args.edit not in {item.id for item in sample.items}:
            raise ValueError("--edit ID is not in this sample")
        pending = [item for item in sample.items if item.id == args.edit]
    else:
        pending = [item for item in sample.items if item.id not in progress.labels]
    saved = 0
    try:
        for item in pending:
            if args.max_items is not None and saved >= args.max_items:
                break
            while True:
                try:
                    entry = _human_label(item)
                    break
                except (ValidationError, ValueError):
                    print("Rótulo inválido ou duplicado. Revise esta review e tente novamente; q para sair.")
            next_progress = progress.model_copy(deep=True)
            next_progress.labels[item.id] = entry
            dataset = labeled_dataset(sample, next_progress)
            write_json_atomic(progress_path, next_progress)
            write_json_atomic(dataset_path, dataset)
            progress = next_progress
            saved += 1
            print(f"Rótulo salvo. {len(progress.labels)}/{len(sample.items)} concluídos.")
    except (StopLabeling, KeyboardInterrupt, EOFError):
        print("Rotulagem interrompida; os rótulos já salvos serão retomados na próxima execução.")
    summary = label_counts(sample, progress)
    print(f"Human labels={summary['human_labeled']}; remaining={summary['remaining']}; "
          f"problem={summary['problem']}; no_problem={summary['no_problem']}; "
          f"insufficient={summary['insufficient_evidence']}; outside_taxonomy={summary['outside_taxonomy']}.")


def validate(args: argparse.Namespace) -> None:
    sample_path, progress_path, dataset_path = map(private_path,
                                                   (args.sample, args.progress, args.dataset))
    sample = load_sample(sample_path)
    if not progress_path.exists():
        if dataset_path.exists():
            raise ValueError("evaluation dataset exists without label progress")
        print(f"Sample valid: {len(sample.items)} reviews; human labels=0. Start the label command.")
        return
    progress = load_progress(progress_path)
    expected = labeled_dataset(sample, progress)
    if progress.labels:
        saved = load_dataset(dataset_path)[0]
        if saved.model_dump(mode="json") != expected.model_dump(mode="json"):
            raise ValueError("dataset does not match saved human labels")
    summary = label_counts(sample, progress)
    print(f"Valid: sampled={summary['sampled']}; human_labeled={summary['human_labeled']}; "
          f"remaining={summary['remaining']}; problem={summary['problem']}; "
          f"no_problem={summary['no_problem']}; insufficient={summary['insufficient_evidence']}; "
          f"outside_taxonomy={summary['outside_taxonomy']}.")


async def main(argv: list[str] | None = None) -> None:
    args = parse_args(argv)
    try:
        if args.command == "sources":
            pairs = source_pairs()
            if not pairs:
                print("No locally collected Steam reviews found.")
            for tenant, app, documents, unique in pairs:
                print(f"tenant_id={tenant} app_id={app} stored={documents} unique_reviews={unique}")
        elif args.command == "sample":
            await prepare(args)
        elif args.command == "label":
            label(args)
        else:
            validate(args)
    except (ValidationError, SteamCollectionError, ValueError, OSError, psycopg.Error) as error:
        # Pydantic/database errors can embed review text or connection details: emit only a safe category.
        code = error.code if isinstance(error, SteamCollectionError) else type(error).__name__
        raise SystemExit(f"Steam evaluation command failed ({code}); check input, private files and source status") from None


if __name__ == "__main__":
    if os.name == "nt":
        asyncio.run(main(), loop_factory=asyncio.SelectorEventLoop)
    else:
        asyncio.run(main())
