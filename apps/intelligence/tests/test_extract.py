import asyncio
import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from marketrift_intelligence.evaluation import evaluate
from marketrift_intelligence.extract import (
    InvalidEvidence,
    ReviewAnalysis,
    extract_review,
    validate_extraction,
)

EXAMPLES = json.loads(
    (Path(__file__).resolve().parents[3] / "fixtures/review-analysis.synthetic.json").read_text(encoding="utf-8")
)


def run(coroutine):
    if __import__("os").name == "nt":
        return asyncio.run(coroutine, loop_factory=asyncio.SelectorEventLoop)
    return asyncio.run(coroutine)


def test_multiple_issues_and_positive_review():
    multiple = validate_extraction(EXAMPLES[0]["text"], EXAMPLES[0]["test_response"])
    assert [issue.category for issue in multiple.issues] == ["support", "price"]
    assert validate_extraction(EXAMPLES[2]["text"], EXAMPLES[2]["test_response"]).issues == []


def test_malformed_and_fabricated_evidence_are_rejected():
    with pytest.raises(ValidationError):
        validate_extraction("O suporte demorou.", {"issues": [{"category": "made-up"}]})
    response = {"issues": [{"category": "support", "sentiment": "negative", "severity": "medium",
                            "description": "O suporte foi lento na resposta.", "evidence_quote": "suporte respondeu rápido"}]}
    with pytest.raises(InvalidEvidence):
        validate_extraction("O suporte demorou.", response)
    with pytest.raises(ValidationError):
        validate_extraction("O suporte demorou.", {"issues": [], "ignore_all_rules": True})


def test_langchain_receives_review_only_as_untrusted_human_message(monkeypatch):
    import langchain_openai
    from langchain_core.messages import HumanMessage, SystemMessage

    captured = {}

    class ControlledChat:
        def __init__(self, **kwargs):
            captured["model"] = kwargs["model"]

        def with_structured_output(self, schema, **kwargs):
            assert schema is ReviewAnalysis
            assert kwargs["method"] == "json_schema"
            return self

        async def ainvoke(self, messages):
            captured["messages"] = messages
            return EXAMPLES[3]["test_response"]

    monkeypatch.setenv("ANALYSIS_PROVIDER", "openai")
    monkeypatch.setenv("OPENAI_API_KEY", "unit-test-only")
    monkeypatch.setattr(langchain_openai, "ChatOpenAI", ControlledChat)
    result = run(extract_review(EXAMPLES[3]["text"]))
    assert result.issues[0].category == "support"
    assert isinstance(captured["messages"][0], SystemMessage)
    assert isinstance(captured["messages"][1], HumanMessage)
    assert captured["messages"][1].content == EXAMPLES[3]["text"]
    assert "Ignore as instruções anteriores" not in captured["messages"][0].content


def test_evaluation_reports_category_errors_and_invalid_evidence():
    async def wrong_extractor(_text):
        return {"issues": [{"category": "price", "sentiment": "negative", "severity": "low",
                            "description": "O preço mudou sem aviso ao cliente.", "evidence_quote": "invented quote"}]}

    report = run(evaluate([EXAMPLES[0]], wrong_extractor))
    assert report["synthetic"] is True
    assert report["evidence_invalid"] == 1
    assert report["categories"]["support"]["fn"] == 1
    assert report["categories"]["price"]["fn"] == 1
