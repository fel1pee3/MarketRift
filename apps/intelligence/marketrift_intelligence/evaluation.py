"""Evaluate the extraction mechanism on labeled examples; bundled labels are synthetic."""

import argparse
import asyncio
import json
import os
from collections.abc import Awaitable, Callable
from pathlib import Path

from pydantic import ValidationError

from .extract import CATEGORIES, ReviewAnalysis, extract_review

FIXTURES = Path(__file__).resolve().parents[3] / "fixtures/review-analysis.synthetic.json"


async def evaluate(examples: list[dict], extractor: Callable[[str], Awaitable[object]]) -> dict:
    categories = {category: {"tp": 0, "fp": 0, "fn": 0} for category in CATEGORIES}
    report = {"examples": len(examples), "synthetic": all(x.get("synthetic") is True for x in examples),
              "malformed": 0, "evidence_valid": 0, "evidence_invalid": 0, "categories": categories}
    for example in examples:
        expected = set(example["expected_categories"])
        try:
            raw = await extractor(example["text"])
            parsed = ReviewAnalysis.model_validate(raw)
        except (ValidationError, ValueError, TypeError):
            report["malformed"] += 1
            parsed = ReviewAnalysis(issues=[])
        actual = set()
        for issue in parsed.issues:
            if issue.evidence_quote in example["text"]:
                report["evidence_valid"] += 1
                actual.add(issue.category)
            else:
                report["evidence_invalid"] += 1
        for category in CATEGORIES:
            if category in expected and category in actual:
                categories[category]["tp"] += 1
            elif category in actual:
                categories[category]["fp"] += 1
            elif category in expected:
                categories[category]["fn"] += 1
    return report


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--provider", choices=("test",), required=True)
    args = parser.parse_args()
    os.environ["ANALYSIS_PROVIDER"] = args.provider
    os.environ["MARKETRIFT_TEST_MODE"] = "1"
    examples = json.loads(FIXTURES.read_text(encoding="utf-8"))
    result = await evaluate(examples, extract_review)
    result["provider"] = args.provider
    result["real_model_called"] = False
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    if os.name == "nt":
        asyncio.run(main(), loop_factory=asyncio.SelectorEventLoop)
    else:
        asyncio.run(main())
