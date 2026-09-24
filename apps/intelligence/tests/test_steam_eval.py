"""Private Steam sampling and human labeling without network, AI, or tenant writes."""

import argparse
import tempfile
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import UUID

import pytest
from pydantic import ValidationError

import marketrift_intelligence.steam_eval_cli as cli
from marketrift_intelligence.quality_eval import GoldIssue, GoldLabel
from marketrift_intelligence.steam_eval import (
    LabelEntry,
    LabelProgress,
    SampleItem,
    SteamSample,
    label_counts,
    labeled_dataset,
    load_progress,
    review_digest,
    sample_id,
    select_sample,
    validate_progress,
    write_json_atomic,
)

TENANT = UUID("11111111-1111-4111-8111-111111111111")
NOW = datetime(2026, 9, 1, tzinfo=UTC)


@pytest.fixture
def local_tmp():
    root = Path(__file__).resolve().parents[3] / ".tmp"
    root.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(dir=root) as directory:
        yield Path(directory)


def item(identifier: str, *, text: str = "Specific problem in this review.",
         voted_up: bool = False, updated: datetime = NOW,
         provenance: str = "tenant_document") -> SampleItem:
    return SampleItem(id=sample_id(620, identifier), app_id=620, external_id=identifier,
                      text=text, language="english", created_at=NOW, updated_at=updated,
                      source_url="https://store.steampowered.com/app/620/#app_reviews_hash",
                      voted_up=voted_up, provenance=provenance)


def sample(items: list[SampleItem]) -> SteamSample:
    return SteamSample(dataset_id="steam-reviews-620-real", version="1.0.0",
                       tenant_id=TENANT, app_id=620, created_at=NOW, items=items)


def progress(**labels: LabelEntry) -> LabelProgress:
    return LabelProgress(dataset_id="steam-reviews-620-real", version="1.0.0",
                         tenant_id=TENANT, app_id=620, labeler="human:tester",
                         rights_basis="Authorized local test fixture", labels=labels)


def test_selection_deduplicates_same_app_review_across_product_sources_and_balances():
    older = item("1", text="Old", updated=NOW - timedelta(days=1))
    newer = item("1", text="Updated review", provenance="steam_api")
    candidates = [older, newer, item("2", voted_up=True, text="Good"),
                  item("3", voted_up=True, text="Good controls"),
                  item("4", text="Slow performance"),
                  item("5", text="x" * 120), item("6", voted_up=True, text="y" * 600)]
    chosen = select_sample(candidates, 6)
    assert len(chosen) == len({(value.app_id, value.external_id) for value in chosen}) == 6
    assert next(value for value in chosen if value.external_id == "1").text == "Updated review"
    assert sum(value.voted_up for value in chosen) == 3
    assert {"short", "medium", "long"} == {
        "short" if len(value.text) < 100 else "medium" if len(value.text) < 500 else "long"
        for value in chosen
    }
    assert [value.id for value in select_sample(candidates, 6)] == [value.id for value in chosen]
    assert select_sample(candidates, 6, chosen[:2])[:2] == chosen[:2]
    with pytest.raises(ValueError, match="cannot shrink"):
        select_sample(candidates, 2, chosen[:3])


def test_label_validation_requires_exact_evidence_and_separates_outside_taxonomy():
    first = item("11", text="The ending is frustrating and the controls lag.")
    valid = LabelEntry(review_sha256=review_digest(first), case_type="complaint",
                       gold=GoldLabel(decision="problem", issues=[
                           GoldIssue(category="out_of_taxonomy", outside_topic="story",
                                     evidence_quote="ending is frustrating", severity=None),
                           GoldIssue(category="performance", evidence_quote="controls lag",
                                     severity="low")]))
    dataset = labeled_dataset(sample([first]), progress(**{first.id: valid}))
    assert dataset.schema_version == "review-quality-dataset-v2"
    assert [issue.category for issue in dataset.examples[0].gold.issues] == [
        "out_of_taxonomy", "performance"]
    assert dataset.examples[0].source.external_id == "11"
    assert dataset.examples[0].source.voted_up is False
    assert dataset.examples[0].source.created_at == NOW
    with pytest.raises(ValidationError, match="literal substring"):
        labeled_dataset(sample([first]), progress(**{first.id: valid.model_copy(update={
            "gold": GoldLabel(decision="problem", issues=[
                GoldIssue(category="performance", evidence_quote="invented quote", severity=None)])})}))
    with pytest.raises(ValueError, match="changed"):
        validate_progress(sample([item("11", text="Changed review")]), progress(**{first.id: valid}))
    with pytest.raises(ValidationError, match="duplicate review"):
        sample([first, first])


def test_label_command_saves_each_answer_and_resumes_without_model_predictions(local_tmp, monkeypatch, capsys):
    first = item("11", text="Pleasant experience.", voted_up=True)
    second = item("12", text="Hard to tell what happened.")
    sample_path = local_tmp / "sample.json"
    progress_path = local_tmp / "progress.json"
    dataset_path = local_tmp / "dataset.json"
    write_json_atomic(sample_path, sample([first, second]))
    monkeypatch.setattr(cli, "private_path", lambda path: path)
    args = argparse.Namespace(sample=sample_path, progress=progress_path, dataset=dataset_path,
                              labeler="human:tester", rights_basis="Authorized local test fixture",
                              max_items=None, edit=None)
    answers = iter(["n", "p", "q"])
    monkeypatch.setattr("builtins.input", lambda _: next(answers))
    cli.label(args)
    assert list(load_progress(progress_path).labels) == [first.id]
    assert len(cli.load_dataset(dataset_path)[0].examples) == 1
    assert "prediction" not in capsys.readouterr().out.lower()

    # Simulate a stop between the two atomic writes; resume rebuilds the derived dataset.
    dataset_path.unlink()
    answers = iter(["i"])
    monkeypatch.setattr("builtins.input", lambda _: next(answers))
    cli.label(args)
    saved = load_progress(progress_path)
    assert list(saved.labels) == [first.id, second.id]
    assert label_counts(sample([first, second]), saved)["insufficient_evidence"] == 1
    assert len(cli.load_dataset(dataset_path)[0].examples) == 2
    cli.validate(argparse.Namespace(sample=sample_path, progress=progress_path, dataset=dataset_path))


def test_reviewer_can_mark_outside_topic_with_no_evidenced_severity(monkeypatch):
    first = item("30", text="The game's story ending feels rushed.")
    answers = iter(["p", "o", "story", "story ending feels rushed", "?", "n"])
    monkeypatch.setattr("builtins.input", lambda _: next(answers))
    label = cli._human_label(first)
    assert label.gold.issues[0].category == "out_of_taxonomy"
    assert label.gold.issues[0].severity is None
    assert label.gold.issues[0].outside_topic == "story"


def test_orphaned_export_does_not_masquerade_as_zero_human_labels(local_tmp, monkeypatch):
    current = sample([item("44")])
    sample_path = local_tmp / "sample.json"
    progress_path = local_tmp / "progress.json"
    dataset_path = local_tmp / "dataset.json"
    write_json_atomic(sample_path, current)
    write_json_atomic(dataset_path, labeled_dataset(current, progress()))
    monkeypatch.setattr(cli, "private_path", lambda path: path)
    args = argparse.Namespace(sample=sample_path, progress=progress_path, dataset=dataset_path,
                              labeler="human:tester", rights_basis="Authorized local test fixture",
                              max_items=1, edit=None)
    with pytest.raises(ValueError, match="without label progress"):
        cli.label(args)
    with pytest.raises(ValueError, match="without label progress"):
        cli.validate(args)
