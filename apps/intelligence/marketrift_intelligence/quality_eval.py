"""Offline quality evaluation using the same extract_review call as the worker.

Reports intentionally omit review text, source URLs and evidence quotes. The dataset
contains those fields; exporting a report does not copy them into another file.
"""

import hashlib
import json
import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, date, datetime
from decimal import Decimal
from pathlib import Path
from typing import Literal

from langchain_core.callbacks import get_usage_metadata_callback
from langchain_core.exceptions import OutputParserException
from pydantic import BaseModel, ConfigDict, Field, HttpUrl, ValidationError, model_validator

from .extract import (
    CATEGORIES,
    EXTRACTOR_VERSION,
    PROMPT_VERSION,
    SCHEMA_VERSION,
    SYSTEM_PROMPT,
    TAXONOMY_VERSION,
    Category,
    InvalidEvidence,
    ReviewAnalysis,
    validate_extraction,
)

Decision = Literal["problem", "no_problem", "insufficient_evidence"]
Severity = Literal["low", "medium", "high"]
GoldCategory = Category | Literal["out_of_taxonomy"]
Extractor = Callable[[str], Awaitable[object]]


class Source(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    name: str | None = Field(default=None, max_length=120)
    url: HttpUrl | None = None
    published_at: date | None = None
    app_id: int | None = Field(default=None, ge=1, le=4294967295)
    external_id: str | None = Field(default=None, pattern=r"^[1-9][0-9]{0,29}$")
    language: str | None = Field(default=None, min_length=2, max_length=40)
    created_at: datetime | None = None
    updated_at: datetime | None = None
    voted_up: bool | None = None


class GoldIssue(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    category: GoldCategory
    severity: Severity | None = None
    evidence_quote: str = Field(min_length=3, max_length=500)
    outside_topic: str | None = Field(default=None, min_length=2, max_length=120)

    @model_validator(mode="after")
    def outside_topic_scope(self):
        if self.outside_topic and self.category != "out_of_taxonomy":
            raise ValueError("outside_topic requires out_of_taxonomy category")
        return self


class GoldLabel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    decision: Decision
    issues: list[GoldIssue] = Field(max_length=8)

    @model_validator(mode="after")
    def consistent_decision(self):
        if (self.decision == "problem") != bool(self.issues):
            raise ValueError("problem requires issues; other decisions require none")
        return self


class EvalExample(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    id: str = Field(pattern=r"^[a-z0-9][a-z0-9-]{0,79}$")
    synthetic: bool
    case_type: Literal["positive", "neutral", "complaint", "ambiguous"]
    text: str = Field(min_length=1, max_length=10000)
    source: Source
    labeler: str = Field(min_length=3, max_length=80)
    rights_basis: str | None = Field(default=None, max_length=500)
    gold: GoldLabel

    @model_validator(mode="after")
    def validate_label(self):
        if not self.text.strip():
            raise ValueError("review text must not be blank")
        if self.synthetic:
            if self.labeler != "synthetic-fixture":
                raise ValueError("synthetic examples require synthetic-fixture labeler")
        elif (not re.fullmatch(r"human:[a-z0-9][a-z0-9-]{0,59}", self.labeler)
              or not self.rights_basis or not self.rights_basis.strip()):
            raise ValueError("real examples require a human labeler and rights_basis")
        if self.case_type == "complaint" and self.gold.decision != "problem":
            raise ValueError("complaint case requires a problem label")
        if self.case_type in ("positive", "neutral") and self.gold.decision == "problem":
            raise ValueError("positive and neutral cases cannot have problem labels")
        if self.gold.decision == "insufficient_evidence" and self.case_type != "ambiguous":
            raise ValueError("insufficient_evidence requires ambiguous case_type")
        if len({(issue.category, issue.evidence_quote) for issue in self.gold.issues}) != len(self.gold.issues):
            raise ValueError("duplicate gold issue and evidence")
        if any(issue.evidence_quote not in self.text for issue in self.gold.issues):
            raise ValueError("gold evidence must be a literal substring of text")
        return self


class EvalDataset(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    schema_version: Literal["review-quality-dataset-v1", "review-quality-dataset-v2"]
    dataset_id: str = Field(pattern=r"^[a-z0-9][a-z0-9-]{0,79}$")
    version: str = Field(pattern=r"^[0-9]+\.[0-9]+\.[0-9]+$")
    examples: list[EvalExample] = Field(max_length=1000)

    @model_validator(mode="after")
    def unique_ids(self):
        ids = [example.id for example in self.examples]
        if len(ids) != len(set(ids)):
            raise ValueError("duplicate example id")
        if len({example.synthetic for example in self.examples}) > 1:
            raise ValueError("real and synthetic examples require separate datasets")
        if self.schema_version == "review-quality-dataset-v1" and any(
            issue.category == "out_of_taxonomy" or issue.severity is None
            for example in self.examples for issue in example.gold.issues
        ):
            raise ValueError("out-of-taxonomy labels and unknown severity require dataset v2")
        source_keys = [(example.source.app_id, example.source.external_id)
                       for example in self.examples if example.source.app_id and example.source.external_id]
        if len(source_keys) != len(set(source_keys)):
            raise ValueError("duplicate source review")
        return self


def load_dataset(path: Path) -> tuple[EvalDataset, str]:
    raw = path.read_bytes()
    dataset = EvalDataset.model_validate_json(raw)
    return dataset, hashlib.sha256(raw).hexdigest()


@dataclass(frozen=True)
class EvalSettings:
    provider: Literal["test", "openai"]
    model: str
    max_examples: int
    max_output_tokens: int = 1024
    budget_usd: Decimal | None = None
    input_usd_per_million: Decimal | None = None
    output_usd_per_million: Decimal | None = None

    def __post_init__(self):
        if not 1 <= self.max_examples <= 25:
            raise ValueError("max_examples must be between 1 and 25")
        if not 128 <= self.max_output_tokens <= 2048:
            raise ValueError("max_output_tokens must be between 128 and 2048")
        money = (self.budget_usd, self.input_usd_per_million, self.output_usd_per_million)
        if self.provider == "openai" and any(value is None or not value.is_finite() or value <= 0
                                               for value in money):
            raise ValueError("paid evaluation requires a positive budget and both token rates")


def estimate_input_tokens(text: str) -> int:
    # Conservative preflight reserve: UTF-8 bytes for prompt, review and schema,
    # doubled plus fixed overhead for chat formatting and structured output.
    schema = json.dumps(ReviewAnalysis.model_json_schema(), ensure_ascii=False)
    return 2 * len((SYSTEM_PROMPT + text + schema).encode("utf-8")) + 2048


def estimated_usd(input_tokens: int, output_tokens: int, settings: EvalSettings) -> Decimal:
    if settings.provider == "test":
        return Decimal(0)
    assert settings.input_usd_per_million is not None
    assert settings.output_usd_per_million is not None
    return (Decimal(input_tokens) * settings.input_usd_per_million
            + Decimal(output_tokens) * settings.output_usd_per_million) / Decimal(1_000_000)


def _ratio(numerator: int, denominator: int) -> float | None:
    return round(numerator / denominator, 4) if denominator else None


def _scores(counts: dict[str, int]) -> dict:
    tp, fp, fn = counts["tp"], counts["fp"], counts["fn"]
    return {**counts, "precision": _ratio(tp, tp + fp), "recall": _ratio(tp, tp + fn),
            "f1": _ratio(2 * tp, 2 * tp + fp + fn)}


def _usage(callback) -> tuple[int | None, int | None]:
    if not callback.usage_metadata:
        return None, None
    return (sum(item.get("input_tokens", 0) for item in callback.usage_metadata.values()),
            sum(item.get("output_tokens", 0) for item in callback.usage_metadata.values()))


def _evidence_agreement(example: EvalExample, analysis: ReviewAnalysis) -> tuple[int, int, int]:
    """Count same-category quote containment and severity on one-to-one gold matches."""
    used: set[int] = set()
    aligned = severity_correct = severity_scored = 0
    for predicted in analysis.issues:
        for index, gold in enumerate(example.gold.issues):
            if index in used or gold.category != predicted.category:
                continue
            if predicted.evidence_quote in gold.evidence_quote or gold.evidence_quote in predicted.evidence_quote:
                used.add(index)
                aligned += 1
                if gold.severity is not None:
                    severity_scored += 1
                    severity_correct += predicted.severity == gold.severity
                break
    return aligned, severity_correct, severity_scored


async def evaluate_quality(
    dataset: EvalDataset, dataset_sha256: str, settings: EvalSettings, extractor: Extractor,
) -> dict:
    if not dataset.examples:
        raise ValueError("dataset has no labeled examples")
    selected = dataset.examples[:settings.max_examples]
    categories = {name: {"tp": 0, "fp": 0, "fn": 0, "tn": 0} for name in CATEGORIES}
    presence = {"tp": 0, "fp": 0, "fn": 0, "tn": 0}
    rows: list[dict] = []
    format_failures = missing_evidence = invalid_evidence = provider_failures = 0
    literal_issues = aligned_issues = severity_correct = severity_scored = 0
    outside_examples = outside_only = outside_forced = 0
    correct_insufficient = scored = real_calls = 0
    input_total = output_total = 0
    missing_usage = 0
    measured_cost = gate_used = Decimal(0)
    stopped = None
    for position, example in enumerate(selected):
        reserved = (estimated_usd(estimate_input_tokens(example.text), settings.max_output_tokens, settings)
                    if settings.provider == "openai" else Decimal(0))
        if settings.budget_usd is not None and gate_used + reserved > settings.budget_usd:
            stopped = "budget_preflight"
            for skipped in selected[position:]:
                rows.append({"id": skipped.id, "synthetic": skipped.synthetic,
                             "case_type": skipped.case_type, "expected_decision": skipped.gold.decision,
                             "expected_categories": sorted({issue.category for issue in skipped.gold.issues
                                                            if issue.category in CATEGORIES}),
                             "expected_out_of_taxonomy": any(issue.category == "out_of_taxonomy"
                                                             for issue in skipped.gold.issues),
                             "status": "budget_skipped", "tokens": {"input": None, "output": None},
                             "reserved_usd": 0.0, "estimated_cost_usd": None})
            break
        gate_used += reserved
        row = {"id": example.id, "synthetic": example.synthetic, "case_type": example.case_type,
               "expected_decision": example.gold.decision,
               "expected_categories": sorted({issue.category for issue in example.gold.issues
                                              if issue.category in CATEGORIES}),
               "expected_out_of_taxonomy": any(issue.category == "out_of_taxonomy"
                                               for issue in example.gold.issues),
               "reserved_usd": float(reserved)}
        if settings.provider == "openai":
            real_calls += 1
        with get_usage_metadata_callback() as callback:
            try:
                analysis = validate_extraction(example.text, await extractor(example.text))
            except InvalidEvidence as error:
                invalid_evidence += error.count
                row.update(status="invalid_evidence", error_code="InvalidEvidence",
                           invalid_evidence_count=error.count)
                analysis = None
            except ValidationError as error:
                if error.errors() and all("evidence_quote" in item["loc"] for item in error.errors()):
                    missing_evidence += 1
                    row.update(status="missing_evidence", error_code="MissingEvidence")
                else:
                    format_failures += 1
                    row.update(status="invalid_format", error_code="ValidationError")
                analysis = None
            except (OutputParserException, TypeError):
                format_failures += 1
                row.update(status="invalid_format", error_code="ValidationError")
                analysis = None
            except Exception as error:  # noqa: BLE001 - provider failures must not expose text or response
                provider_failures += 1
                row.update(status="provider_error", error_code=type(error).__name__)
                analysis = None
        input_tokens, output_tokens = _usage(callback)
        row["tokens"] = {"input": input_tokens, "output": output_tokens}
        if settings.provider == "test":
            row["estimated_cost_usd"] = 0.0
        elif input_tokens is None or output_tokens is None:
            missing_usage += 1
            row["estimated_cost_usd"] = None
        else:
            input_total += input_tokens
            output_total += output_tokens
            call_cost = estimated_usd(input_tokens, output_tokens, settings)
            measured_cost += call_cost
            gate_used += max(call_cost - reserved, Decimal(0))
            row["estimated_cost_usd"] = float(call_cost)
        if analysis is None:
            rows.append(row)
            continue
        scored += 1
        actual = {issue.category for issue in analysis.issues}
        expected = {issue.category for issue in example.gold.issues if issue.category in CATEGORIES}
        row.update(status="scored", predicted_decision="problem" if actual else "no_problem",
                   expected_in_scope_decision="problem" if expected else "no_problem",
                   predicted_categories=sorted(actual), false_positive_categories=sorted(actual - expected),
                   false_negative_categories=sorted(expected - actual),
                   literal_evidence_count=len(analysis.issues))
        if row["expected_out_of_taxonomy"]:
            outside_examples += 1
            if not expected:
                outside_only += 1
                if actual:
                    outside_forced += 1
        literal_issues += len(analysis.issues)
        aligned, severity_matches, severity_eligible = _evidence_agreement(example, analysis)
        row["evidence_aligned_with_gold"] = aligned
        row["severity_correct_on_aligned"] = severity_matches
        row["severity_scored_on_aligned"] = severity_eligible
        aligned_issues += aligned
        severity_correct += severity_matches
        severity_scored += severity_eligible
        if example.gold.decision == "insufficient_evidence" and not actual:
            correct_insufficient += 1
        expected_problem, predicted_problem = bool(expected), bool(actual)
        presence["tp" if expected_problem and predicted_problem else
                 "fp" if predicted_problem else "fn" if expected_problem else "tn"] += 1
        for category in CATEGORIES:
            categories[category]["tp" if category in expected and category in actual else
                                 "fp" if category in actual else "fn" if category in expected else "tn"] += 1
        rows.append(row)
    return {
        "report_schema_version": "review-quality-report-v2",
        "dataset": {"id": dataset.dataset_id, "version": dataset.version,
                    "schema_version": dataset.schema_version, "sha256": dataset_sha256,
                    "total_examples": len(dataset.examples), "selected_examples": len(selected),
                    "selected_real": sum(not item.synthetic for item in selected),
                    "selected_synthetic": sum(item.synthetic for item in selected)},
        "run": {"at_utc": datetime.now(UTC).isoformat(), "provider": settings.provider,
                "model": settings.model, "extractor_version": EXTRACTOR_VERSION,
                "prompt_version": PROMPT_VERSION, "schema_version": SCHEMA_VERSION,
                "taxonomy_version": TAXONOMY_VERSION, "max_examples": settings.max_examples,
                "max_output_tokens": settings.max_output_tokens, "api_calls_attempted": real_calls,
                "evaluated": len(rows) - sum(row["status"] == "budget_skipped" for row in rows),
                "scored": scored, "stopped": stopped,
                "input_usd_per_million": float(settings.input_usd_per_million or 0),
                "output_usd_per_million": float(settings.output_usd_per_million or 0),
                "budget_usd": float(settings.budget_usd) if settings.budget_usd is not None else None,
                "preflight_budget_reserved_usd": float(gate_used),
                "reported_input_tokens": input_total if settings.provider == "openai" else 0,
                "reported_output_tokens": output_total if settings.provider == "openai" else 0,
                "calls_without_token_usage": missing_usage,
                "usage_based_estimated_cost_usd": float(measured_cost) if not missing_usage else None},
        "metrics": {"scored_examples": scored,
                    "unscored_examples": sum(row["status"] not in ("scored", "budget_skipped") for row in rows),
                    "budget_skipped_examples": sum(row["status"] == "budget_skipped" for row in rows),
                    "format_failures": format_failures, "invalid_evidence_quotes": invalid_evidence,
                    "missing_evidence_responses": missing_evidence,
                    "provider_failures": provider_failures, "problem_presence": _scores(presence),
                    "categories": {name: _scores(counts) for name, counts in categories.items()},
                    "literal_evidence_issues": literal_issues,
                    "evidence_aligned_with_gold": aligned_issues,
                    "evidence_alignment_rate": _ratio(aligned_issues, literal_issues),
                    "severity_correct_on_aligned": severity_correct,
                    "severity_scored_on_aligned": severity_scored,
                    "severity_accuracy_on_aligned": _ratio(severity_correct, severity_scored),
                    "outside_taxonomy_examples": outside_examples,
                    "outside_only_examples": outside_only,
                    "outside_only_forced_into_taxonomy": outside_forced,
                    "insufficient_evidence_correct": correct_insufficient},
        "examples": rows,
    }
