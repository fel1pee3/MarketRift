"""Private B2B labeling and evaluation gates, without external calls."""

import argparse
import asyncio
import tempfile
from datetime import UTC, datetime
from pathlib import Path
from uuid import UUID

import pytest
from pydantic import ValidationError

import marketrift_intelligence.b2b_eval_cli as cli
from marketrift_intelligence.b2b_eval import (
    B2BItem, B2BProgress, B2BSample, item_digest, item_id, labeled_dataset,
    load_progress, select_items,
)
from marketrift_intelligence.quality_eval import EvalSettings, GoldIssue, GoldLabel, evaluate_quality
from marketrift_intelligence.steam_eval import LabelEntry, write_json_atomic

TENANT = UUID("11111111-1111-4111-8111-111111111111")
SOURCE = UUID("22222222-2222-4222-8222-222222222222")
DOCUMENT = UUID("33333333-3333-4333-8333-333333333333")


def item(text="A exportação de faturas falhou duas vezes.", key="r1", synthetic=False):
    return B2BItem(id=item_id(SOURCE, key), tenant_id=TENANT, source_id=SOURCE,
                   document_id=DOCUMENT, external_key=key, text=text,
                   source_url="https://reviews.example.org/r1",
                   published_at=datetime(2026, 9, 1, tzinfo=UTC), language="pt",
                   synthetic=synthetic,
                   review_data_status="synthetic_fixture" if synthetic else "declared_real")


def sample(items, synthetic=False):
    return B2BSample(dataset_id="b2b-fixture-real", version="1.0.0", tenant_id=TENANT,
                     source_id=SOURCE, synthetic=synthetic, items=items)


def progress(labels):
    return B2BProgress(dataset_id="b2b-fixture-real", version="1.0.0", tenant_id=TENANT,
                       source_id=SOURCE, labeler="human:tester",
                       rights_basis="Test fixture; permission basis documented for tests", labels=labels)


def test_select_deduplicates_and_labels_require_literal_evidence():
    first = item()
    selected = select_items([first, first, item("Gostei do produto.", "r2")], 2)
    assert len(selected) == 2
    entry = LabelEntry(review_sha256=item_digest(first), case_type="complaint",
                       gold=GoldLabel(decision="problem", issues=[GoldIssue(
                           category="features", severity=None,
                           evidence_quote="exportação de faturas falhou")]))
    dataset = labeled_dataset(sample([first]), progress({first.id: entry}))
    assert dataset.examples[0].source.document_id == DOCUMENT
    assert dataset.examples[0].labeler == "human:tester"
    assert dataset.examples[0].source.kind == "b2b_csv"
    invalid = entry.model_copy(update={"gold": GoldLabel(decision="problem", issues=[GoldIssue(
        category="features", evidence_quote="trecho inventado")])})
    with pytest.raises(ValidationError, match="literal substring"):
        labeled_dataset(sample([first]), progress({first.id: invalid}))
    with pytest.raises(ValueError, match="changed"):
        labeled_dataset(sample([item("Texto alterado")]), progress({first.id: entry}))


def test_private_label_resume_without_predictions(monkeypatch, capsys):
    first, second = item("Tudo funcionou.", "r1"), item("Não ficou claro o problema.", "r2")
    with tempfile.TemporaryDirectory() as folder:
        folder = Path(folder)
        sample_path, progress_path, dataset_path = (folder / name for name in
                                                    ("sample.json", "progress.json", "dataset.json"))
        write_json_atomic(sample_path, sample([first, second]))
        monkeypatch.setattr(cli, "private_path", lambda path: path)
        monkeypatch.setattr(cli, "load_sample", lambda path: B2BSample.model_validate_json(path.read_bytes()))
        monkeypatch.setattr(cli, "load_progress", lambda path: B2BProgress.model_validate_json(path.read_bytes()))
        args = argparse.Namespace(sample=sample_path, progress=progress_path, dataset=dataset_path,
                                  labeler="human:tester", rights_basis="Test fixture; permission basis documented",
                                  max_items=1)
        answers = iter(["n", "p"])
        monkeypatch.setattr("builtins.input", lambda _: next(answers))
        cli.label(args)
        assert len(load_progress_override(progress_path).labels) == 1
        assert "previsão" not in capsys.readouterr().out.lower().replace("nenhuma previsão da ia será mostrada", "")
        # Rebuild the derived export from saved progress, then continue.
        dataset_path.unlink()
        args.max_items = None
        answers = iter(["i"])
        monkeypatch.setattr("builtins.input", lambda _: next(answers))
        cli.label(args)
        assert len(load_progress_override(progress_path).labels) == 2
        cli.validate(args)


def test_orphaned_export_cannot_look_like_zero_labels(monkeypatch):
    with tempfile.TemporaryDirectory() as folder:
        folder = Path(folder)
        sample_path, progress_path, dataset_path = (folder / name for name in
                                                    ("sample.json", "progress.json", "dataset.json"))
        write_json_atomic(sample_path, sample([item()]))
        dataset_path.write_text("{}", encoding="utf-8")
        monkeypatch.setattr(cli, "private_path", lambda path: path)
        monkeypatch.setattr(cli, "load_sample", lambda path: B2BSample.model_validate_json(path.read_bytes()))
        with pytest.raises(ValueError, match="without human label progress"):
            cli.validate(argparse.Namespace(sample=sample_path, progress=progress_path,
                                            dataset=dataset_path))


def load_progress_override(path):
    return B2BProgress.model_validate_json(path.read_bytes())


def test_quality_report_distinguishes_synthetic_and_rights_denial():
    synthetic = item("A exportação de faturas falhou duas vezes.", synthetic=True)
    entry = LabelEntry(review_sha256=item_digest(synthetic), case_type="complaint",
                       gold=GoldLabel(decision="problem", issues=[GoldIssue(
                           category="features", severity="medium",
                           evidence_quote="exportação de faturas falhou")]))
    data = labeled_dataset(sample([synthetic], synthetic=True), progress({synthetic.id: entry}))

    async def fixture(_text):
        return {"issues": [{"category": "features", "sentiment": "negative", "severity": "medium",
                            "description": "Export failed.",
                            "evidence_quote": "exportação de faturas falhou"}]}

    report = asyncio.run(evaluate_quality(data, "fixture", EvalSettings("test", "controlled", 1), fixture))
    assert report["dataset"]["selected_real"] == 0
    assert report["metrics"]["categories"]["features"]["tp"] == 1

    async def denied(_example):
        raise PermissionError

    called = False

    async def must_not_call(_text):
        nonlocal called
        called = True

    blocked = asyncio.run(evaluate_quality(data, "fixture", EvalSettings("test", "controlled", 1),
                                           must_not_call, denied))
    assert not called
    assert blocked["examples"][0]["status"] == "rights_denied"
    assert blocked["metrics"]["rights_denied_examples"] == 1
