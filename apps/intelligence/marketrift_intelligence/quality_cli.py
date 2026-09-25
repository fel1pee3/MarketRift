"""Explicit, budgeted CLI for review extraction quality evaluation."""

import argparse
import asyncio
import json
import os
import re
from contextvars import ContextVar
from decimal import Decimal
from pathlib import Path

from pydantic import ValidationError

from .extract import extract_review
from .b2b_eval import extract_with_current_rights
from .quality_eval import EvalSettings, evaluate_quality, load_dataset
from .steam_eval import private_path

DEFAULT_DATASET = Path(__file__).resolve().parents[3] / "evalsets/review-quality.synthetic.v1.json"


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Evaluate review extraction without writing tenant data")
    parser.add_argument("--dataset", type=Path, default=DEFAULT_DATASET)
    parser.add_argument("--provider", choices=("test", "openai"), default="test")
    parser.add_argument("--model", help="Required for OpenAI; test uses controlled-test-fixture-v1")
    parser.add_argument("--allow-paid", action="store_true", help="Explicitly authorize live model calls")
    parser.add_argument("--max-examples", type=int, default=None, help="Maximum examples and calls (1-25)")
    parser.add_argument("--max-output-tokens", type=int, default=1024)
    parser.add_argument("--budget-usd", type=Decimal)
    parser.add_argument("--input-usd-per-million", type=Decimal)
    parser.add_argument("--output-usd-per-million", type=Decimal)
    parser.add_argument("--output", type=Path, help="Write a text-free JSON report to this path")
    args = parser.parse_args(argv)
    if args.provider == "openai":
        if not args.allow_paid or not args.model or args.max_examples is None:
            parser.error("OpenAI requires --allow-paid, --model and --max-examples")
        if not os.getenv("OPENAI_API_KEY"):
            parser.error("OPENAI_API_KEY must be present in the local environment")
        if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}", args.model):
            parser.error("--model must be a model identifier without spaces or control characters")
    elif args.model not in (None, "controlled-test-fixture-v1"):
        parser.error("test provider uses controlled-test-fixture-v1")
    return args


def render_markdown(report: dict) -> str:
    run, dataset, metrics = report["run"], report["dataset"], report["metrics"]
    presence = metrics["problem_presence"]
    lines = [
        "# Review extraction quality",
        f"Dataset: {dataset['id']} v{dataset['version']} (SHA-256 {dataset['sha256']})",
        (f"Selected: {dataset['selected_examples']} ({dataset['selected_real']} real, "
         f"{dataset['selected_synthetic']} synthetic); scored: {run['scored']}; "
         f"attempted API calls: {run['api_calls_attempted']}; stopped: {run['stopped'] or 'no'}"),
        (f"Scored real reviews: {metrics['scored_real_examples']}; "
         f"scored synthetic: {metrics['scored_synthetic_examples']}. "
         "Synthetic scores do not measure quality on real B2B customers."),
        (f"Model: {run['provider']}/{run['model']}; prompt: {run['prompt_version']}; "
         f"schema: {run['schema_version']}; taxonomy: {run['taxonomy_version']}"),
        (f"Tokens reported: {run['reported_input_tokens']} input, {run['reported_output_tokens']} output; "
         f"calls without usage: {run['calls_without_token_usage']}"),
        (f"Usage-based estimated cost USD: {run['usage_based_estimated_cost_usd']}; "
         f"preflight budget reserved USD: {run['preflight_budget_reserved_usd']}; "
         f"budget USD: {run['budget_usd']}"),
        (f"In-taxonomy problem presence: TP={presence['tp']} FP={presence['fp']} FN={presence['fn']} "
         f"TN={presence['tn']}; precision={presence['precision']} recall={presence['recall']} F1={presence['f1']}"),
        (f"Failures: format={metrics['format_failures']}, missing evidence="
         f"{metrics['missing_evidence_responses']}, invented evidence="
         f"{metrics['invalid_evidence_quotes']}, "
         f"provider={metrics['provider_failures']}; unscored={metrics['unscored_examples']}"),
        f"Rights denied before call: {metrics['rights_denied_examples']}",
        (f"Evidence aligned with gold: {metrics['evidence_aligned_with_gold']}/"
         f"{metrics['literal_evidence_issues']}; severity correct on aligned: "
         f"{metrics['severity_correct_on_aligned']}/{metrics['severity_scored_on_aligned']}"),
        (f"Outside taxonomy (scored): {metrics['outside_taxonomy_examples']}; "
         f"outside-only: {metrics['outside_only_examples']}; "
         f"forced into an existing category: {metrics['outside_only_forced_into_taxonomy']}"),
        f"Insufficient-evidence cases correctly left without claims: {metrics['insufficient_evidence_correct']}",
        "",
        "| Category | TP | FP | FN | TN | Precision | Recall | F1 |",
        "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ]
    for name, counts in metrics["categories"].items():
        lines.append(f"| {name} | {counts['tp']} | {counts['fp']} | {counts['fn']} | {counts['tn']} | "
                     f"{counts['precision']} | {counts['recall']} | {counts['f1']} |")
    lines += ["", ("| Example | Status | Error | Expected | Outside taxonomy | Predicted | FP categories | FN categories | "
                   "Tokens in/out | Est. USD |"),
              "| --- | --- | --- | --- | --- | --- | --- | --- | --- | ---: |"]
    for row in report["examples"]:
        tokens = row["tokens"]
        lines.append(f"| {row['id']} | {row['status']} | {row.get('error_code', '')} | "
                     f"{row['expected_decision']} "
                     f"({','.join(row['expected_categories'])}) | "
                     f"{row['expected_out_of_taxonomy']} | "
                     f"{row.get('predicted_decision', 'unscored')} "
                     f"({','.join(row.get('predicted_categories', []))}) | "
                     f"{','.join(row.get('false_positive_categories', []))} | "
                     f"{','.join(row.get('false_negative_categories', []))} | "
                     f"{tokens['input']}/{tokens['output']} | {row['estimated_cost_usd']} |")
    lines += ["", ("Only in-taxonomy problems enter category and presence TP/FP/FN/TN. "
                   "Outside-only cases are shown separately; an existing-category prediction on one is a forced-category FP. "
                   "A category is counted once per scored example. Precision=TP/(TP+FP), "
                   "recall=TP/(TP+FN), F1=2TP/(2TP+FP+FN); undefined denominators appear as None. "
                   "Failed extractions are unscored, not silently counted as negatives. "
                   "Evidence alignment requires same category and quote containment with one human gold quote; "
                   "severity is scored only when the human supplied it. Alignment does not prove semantic correctness. "
                   "No review text, URL or quote is exported.")]
    return "\n".join(lines)


async def main(argv: list[str] | None = None) -> None:
    args = parse_args(argv)
    try:
        settings = EvalSettings(
            provider=args.provider, model=args.model or "controlled-test-fixture-v1",
            max_examples=args.max_examples if args.max_examples is not None else 5,
            max_output_tokens=args.max_output_tokens,
            budget_usd=args.budget_usd, input_usd_per_million=args.input_usd_per_million,
            output_usd_per_million=args.output_usd_per_million,
        )
        dataset, sha256 = load_dataset(args.dataset)
        if dataset.dataset_id.startswith("b2b-") and any(
                item.source.kind != "b2b_csv" for item in dataset.examples):
            raise ValueError("B2B datasets require B2B source scope")
        if any(item.source.kind == "b2b_csv" for item in dataset.examples):
            private_path(args.dataset)
            if args.provider == "openai" and any(item.synthetic for item in dataset.examples):
                raise ValueError("synthetic B2B data require the controlled test provider")
    except (ValidationError, ValueError, OSError) as error:
        # Validation errors can embed the review text. Never print their messages.
        raise SystemExit(f"Invalid evaluation configuration or dataset ({type(error).__name__})") from None
    os.environ["ANALYSIS_PROVIDER"] = settings.provider
    os.environ["ANALYSIS_MODEL"] = settings.model
    if settings.provider == "test":
        os.environ["MARKETRIFT_TEST_MODE"] = "1"

    active_example = ContextVar("active_quality_example", default=None)

    async def before_extract(example):
        active_example.set(example)

    async def production_extractor(text: str):
        # Same production pipeline, with retries disabled and output capped for this evaluation.
        async def call(body: str):
            return await extract_review(body, max_output_tokens=settings.max_output_tokens, max_retries=0)

        example = active_example.get()
        if example and example.source.kind == "b2b_csv" and not example.synthetic:
            if settings.provider != "openai":
                raise PermissionError("ExternalAIRightsUnavailable")
            return await extract_with_current_rights(example, call)
        return await call(text)

    report = await evaluate_quality(dataset, sha256, settings, production_extractor, before_extract)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(render_markdown(report))


if __name__ == "__main__":
    if os.name == "nt":
        asyncio.run(main(), loop_factory=asyncio.SelectorEventLoop)
    else:
        asyncio.run(main())
