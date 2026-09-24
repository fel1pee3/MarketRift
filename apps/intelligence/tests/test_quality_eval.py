"""Deterministic quality and budget checks; no network or tenant database."""

import asyncio
import json
from contextlib import contextmanager
from dataclasses import replace
from decimal import Decimal
from pathlib import Path

import pytest
from langchain_core.callbacks import UsageMetadataCallbackHandler
from langchain_core.messages import AIMessage
from langchain_core.outputs import ChatGeneration, LLMResult
from pydantic import ValidationError

import marketrift_intelligence.quality_eval as quality_module
from marketrift_intelligence.quality_cli import parse_args, render_markdown
from marketrift_intelligence.quality_eval import (
    EvalDataset,
    EvalSettings,
    _usage,
    estimate_input_tokens,
    estimated_usd,
    evaluate_quality,
    load_dataset,
)

DATASET_PATH = Path(__file__).resolve().parents[3] / "evalsets/review-quality.synthetic.v1.json"


def run(coroutine):
    if __import__("os").name == "nt":
        return asyncio.run(coroutine, loop_factory=asyncio.SelectorEventLoop)
    return asyncio.run(coroutine)


def response(*issues):
    return {"issues": [{"category": category, "sentiment": "negative", "severity": severity,
                        "description": "Specific problem stated by reviewer.", "evidence_quote": quote}
                       for category, severity, quote in issues]}


def test_dataset_requires_literal_gold_human_provenance_and_separate_real_data():
    dataset, digest = load_dataset(DATASET_PATH)
    assert len(dataset.examples) == 6 and len(digest) == 64
    assert {item.case_type for item in dataset.examples} == {"complaint", "positive", "neutral", "ambiguous"}

    payload = dataset.model_dump(mode="json")
    real = payload["examples"][0]
    real["synthetic"] = False
    with pytest.raises(ValidationError):
        EvalDataset.model_validate_json(json.dumps(payload))
    real["labeler"] = "human:reviewer-1"
    real["rights_basis"] = "permitted by source terms and removed personal data"
    with pytest.raises(ValidationError, match="separate datasets"):
        EvalDataset.model_validate_json(json.dumps(payload))

    payload = dataset.model_dump(mode="json")
    payload["examples"][0]["gold"]["issues"][0]["evidence_quote"] = "invented evidence"
    with pytest.raises(ValidationError):
        EvalDataset.model_validate_json(json.dumps(payload))


def test_category_confusion_evidence_alignment_and_insufficient_evidence():
    dataset, digest = load_dataset(DATASET_PATH)
    selected = dataset.model_copy(update={"examples": [dataset.examples[0], dataset.examples[2],
                                                      dataset.examples[5]]})
    answers = {
        selected.examples[0].text: response(
            ("support", "high", "O suporte demorou três dias"),
            ("billing", "low", "o preço aumentou sem aviso")),
        selected.examples[1].text: response(("support", "low", "facilidade de uso")),
        selected.examples[2].text: response(),
    }

    async def fake(text):
        return answers[text]

    report = run(evaluate_quality(selected, digest, EvalSettings("test", "fixture", 3), fake))
    assert report["run"]["api_calls_attempted"] == 0
    assert report["metrics"]["problem_presence"] == {
        "tp": 1, "fp": 1, "fn": 0, "tn": 1, "precision": 0.5, "recall": 1.0, "f1": 0.6667,
    }
    assert report["metrics"]["categories"]["support"]["tp"] == 1
    assert report["metrics"]["categories"]["support"]["fp"] == 1
    assert report["metrics"]["categories"]["price"]["fn"] == 1
    assert report["metrics"]["categories"]["billing"]["fp"] == 1
    assert report["metrics"]["literal_evidence_issues"] == 3
    assert report["metrics"]["evidence_aligned_with_gold"] == 1
    assert report["metrics"]["severity_correct_on_aligned"] == 0
    assert report["metrics"]["insufficient_evidence_correct"] == 1
    assert report["examples"][0]["false_negative_categories"] == ["price"]
    assert report["examples"][0]["false_positive_categories"] == ["billing"]
    exported = json.dumps(report) + render_markdown(report)
    assert all(item.text not in exported for item in selected.examples)
    assert "https://example.invalid" not in exported
    assert "O suporte demorou três dias" not in exported


def test_bad_format_fabricated_quote_and_provider_failure_are_unscored():
    dataset, digest = load_dataset(DATASET_PATH)
    selected = dataset.model_copy(update={"examples": dataset.examples[:3]})

    async def fake(text):
        if text == selected.examples[0].text:
            return {"issues": [{"category": "unknown"}]}
        if text == selected.examples[1].text:
            return response(("billing", "high", "quote absent from review"))
        raise RuntimeError("sensitive review text must not reach reports")

    report = run(evaluate_quality(selected, digest, EvalSettings("test", "fixture", 3), fake))
    assert report["metrics"]["format_failures"] == 1
    assert report["metrics"]["invalid_evidence_quotes"] == 1
    assert report["metrics"]["provider_failures"] == 1
    assert report["metrics"]["unscored_examples"] == 3
    assert report["metrics"]["categories"]["billing"]["fn"] == 0
    assert "sensitive review text" not in json.dumps(report)


def test_budget_preflight_stops_before_any_paid_call_and_respects_example_cap():
    dataset, digest = load_dataset(DATASET_PATH)
    calls = []

    async def fake(text):
        calls.append(text)
        return response()

    settings = EvalSettings("openai", "test-model", 2, budget_usd=Decimal("0.000001"),
                            input_usd_per_million=Decimal(1),
                            output_usd_per_million=Decimal(1))
    assert estimate_input_tokens(dataset.examples[0].text) > 2048
    report = run(evaluate_quality(dataset, digest, settings, fake))
    assert calls == []
    assert report["run"]["api_calls_attempted"] == 0
    assert report["run"]["stopped"] == "budget_preflight"
    assert report["metrics"]["budget_skipped_examples"] == 2
    assert len(report["examples"]) == 2
    with pytest.raises(ValueError):
        replace(settings, max_examples=26)


def test_paid_provider_needs_explicit_opt_in_even_when_environment_has_key(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "unit-test-only")
    with pytest.raises(SystemExit):
        parse_args(["--provider", "openai", "--model", "test-model", "--max-examples", "1"])
    assert parse_args([]).provider == "test"


def test_langchain_token_usage_and_cost_estimate_are_separate_from_budget_reservation():
    callback = UsageMetadataCallbackHandler()
    message = AIMessage(content="", response_metadata={"model_name": "test-model"},
                        usage_metadata={"input_tokens": 1200, "output_tokens": 300, "total_tokens": 1500})
    callback.on_llm_end(LLMResult(generations=[[ChatGeneration(message=message)]]))
    assert _usage(callback) == (1200, 300)
    settings = EvalSettings("openai", "test-model", 1, budget_usd=Decimal("0.01"),
                            input_usd_per_million=Decimal("0.2"),
                            output_usd_per_million=Decimal("0.8"))
    assert estimated_usd(1200, 300, settings) == Decimal("0.00048")


def test_usage_and_cost_appear_in_report_and_reservation_stops_next_example(monkeypatch):
    dataset, digest = load_dataset(DATASET_PATH)

    class FakeCallback:
        def __init__(self):
            self.usage_metadata = {"test-model": {"input_tokens": 1200, "output_tokens": 300}}

    @contextmanager
    def controlled_usage():
        yield FakeCallback()

    monkeypatch.setattr(quality_module, "get_usage_metadata_callback", controlled_usage)
    called = []

    async def fake(text):
        called.append(text)
        return response()

    settings = EvalSettings("openai", "test-model", 2, budget_usd=Decimal("0.01"),
                            input_usd_per_million=Decimal(1), output_usd_per_million=Decimal(1))
    report = run(evaluate_quality(dataset, digest, settings, fake))
    assert len(called) == 1
    assert report["run"]["api_calls_attempted"] == 1
    assert report["run"]["reported_input_tokens"] == 1200
    assert report["run"]["reported_output_tokens"] == 300
    assert report["run"]["usage_based_estimated_cost_usd"] == 0.0015
    assert report["run"]["stopped"] == "budget_preflight"
    assert report["examples"][1]["status"] == "budget_skipped"


def test_outside_taxonomy_is_reported_separately_and_unknown_severity_is_not_scored():
    outside = {
        "id": "game-story", "synthetic": True, "case_type": "complaint",
        "text": "The story ending is disappointing.", "source": {},
        "labeler": "synthetic-fixture", "rights_basis": None,
        "gold": {"decision": "problem", "issues": [{"category": "out_of_taxonomy",
                                                     "outside_topic": "story", "severity": None,
                                                     "evidence_quote": "story ending is disappointing"}]},
    }
    in_scope = {
        "id": "game-lag", "synthetic": True, "case_type": "complaint",
        "text": "The controls lag badly.", "source": {},
        "labeler": "synthetic-fixture", "rights_basis": None,
        "gold": {"decision": "problem", "issues": [{"category": "performance",
                                                     "severity": None, "evidence_quote": "controls lag badly"}]},
    }
    dataset = EvalDataset.model_validate({"schema_version": "review-quality-dataset-v2",
                                          "dataset_id": "steam-fixture", "version": "1.0.0",
                                          "examples": [outside, in_scope]})

    async def fake(text):
        if text == outside["text"]:
            return response(("performance", "low", "story ending is disappointing"))
        return response(("performance", "high", "controls lag badly"))

    report = run(evaluate_quality(dataset, "fixture-hash", EvalSettings("test", "fixture", 2), fake))
    assert report["metrics"]["outside_only_examples"] == 1
    assert report["metrics"]["outside_only_forced_into_taxonomy"] == 1
    assert report["metrics"]["categories"]["performance"]["fp"] == 1
    assert report["metrics"]["categories"]["performance"]["tp"] == 1
    assert report["metrics"]["severity_scored_on_aligned"] == 0
    assert report["metrics"]["severity_accuracy_on_aligned"] is None
    assert report["examples"][0]["expected_out_of_taxonomy"] is True
    assert report["examples"][0]["expected_in_scope_decision"] == "no_problem"
    with pytest.raises(ValidationError, match="dataset v2"):
        EvalDataset.model_validate({"schema_version": "review-quality-dataset-v1",
                                    "dataset_id": "steam-fixture", "version": "1.0.0",
                                    "examples": [outside]})


def test_missing_evidence_field_is_distinct_from_invented_quote():
    dataset, digest = load_dataset(DATASET_PATH)
    selected = dataset.model_copy(update={"examples": dataset.examples[:2]})

    async def fake(text):
        if text == selected.examples[0].text:
            return {"issues": [{"category": "support", "sentiment": "negative",
                                "severity": "low", "description": "Slow support"}]}
        return response(("billing", "high", "fabricated literal quote"))

    report = run(evaluate_quality(selected, digest, EvalSettings("test", "fixture", 2), fake))
    assert report["metrics"]["missing_evidence_responses"] == 1
    assert report["metrics"]["invalid_evidence_quotes"] == 1
    assert report["metrics"]["format_failures"] == 0
    assert report["examples"][0]["status"] == "missing_evidence"
    assert report["examples"][1]["status"] == "invalid_evidence"
