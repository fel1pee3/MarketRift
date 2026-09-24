"""Local, human-only preparation and labeling of Steam review evaluation sets."""

import hashlib
import json
import os
import tempfile
from collections import deque
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, HttpUrl, model_validator

from .quality_eval import EvalDataset, EvalExample, GoldLabel, Source
from .steam_reviews import SteamReview

ROOT = Path(__file__).resolve().parents[3]
PRIVATE_ROOT = ROOT / "evalsets/private"
DEFAULT_SAMPLE = PRIVATE_ROOT / "steam-sample-v1.json"
DEFAULT_PROGRESS = PRIVATE_ROOT / "steam-labels-v1.json"
DEFAULT_DATASET = PRIVATE_ROOT / "reviews-v1.json"


class SampleItem(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    id: str = Field(pattern=r"^steam-[0-9]+-[0-9a-f]{16}$")
    app_id: int = Field(ge=1, le=4294967295)
    external_id: str = Field(pattern=r"^[1-9][0-9]{0,29}$")
    text: str = Field(min_length=1, max_length=10000)
    language: str = Field(min_length=2, max_length=40)
    created_at: datetime
    updated_at: datetime
    source_url: HttpUrl
    voted_up: bool
    provenance: Literal["tenant_document", "steam_api"]

    @model_validator(mode="after")
    def consistent(self):
        if not self.text.strip() or self.id != sample_id(self.app_id, self.external_id):
            raise ValueError("blank text or inconsistent review ID")
        if self.created_at.tzinfo is None or self.updated_at.tzinfo is None:
            raise ValueError("source timestamps must include a timezone")
        if self.source_url.host != "store.steampowered.com":
            raise ValueError("source URL must point to the Steam store")
        return self


class SteamSample(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    schema_version: Literal["steam-review-sample-v1"] = "steam-review-sample-v1"
    dataset_id: str = Field(pattern=r"^[a-z0-9][a-z0-9-]{0,79}$")
    version: str = Field(pattern=r"^[0-9]+\.[0-9]+\.[0-9]+$")
    tenant_id: UUID
    app_id: int = Field(ge=1, le=4294967295)
    created_at: datetime
    items: list[SampleItem] = Field(max_length=50)

    @model_validator(mode="after")
    def unique_reviews(self):
        keys = [(item.app_id, item.external_id) for item in self.items]
        if len(keys) != len(set(keys)) or any(item.app_id != self.app_id for item in self.items):
            raise ValueError("sample contains duplicate reviews or a different App ID")
        return self


class LabelEntry(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    review_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    case_type: Literal["positive", "neutral", "complaint", "ambiguous"]
    gold: GoldLabel


class LabelProgress(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    schema_version: Literal["steam-human-labels-v1"] = "steam-human-labels-v1"
    dataset_id: str
    version: str
    tenant_id: UUID
    app_id: int
    labeler: str = Field(pattern=r"^human:[a-z0-9][a-z0-9-]{0,59}$")
    rights_basis: str = Field(min_length=1, max_length=500)
    labels: dict[str, LabelEntry] = Field(default_factory=dict)


def sample_id(app_id: int, external_id: str) -> str:
    digest = hashlib.sha256(f"{app_id}:{external_id}".encode()).hexdigest()[:16]
    return f"steam-{app_id}-{digest}"


def review_digest(item: SampleItem) -> str:
    raw = json.dumps(item.model_dump(mode="json"), ensure_ascii=False, sort_keys=True)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def private_path(path: Path) -> Path:
    resolved = path.resolve()
    if not resolved.is_relative_to(PRIVATE_ROOT.resolve()):
        raise ValueError("review text and labels must remain under evalsets/private/")
    return resolved


def write_json_atomic(path: Path, payload: BaseModel) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    raw = json.dumps(payload.model_dump(mode="json"), ensure_ascii=False, indent=2) + "\n"
    temporary: str | None = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", newline="\n", dir=path.parent,
                                         prefix=".writing-", suffix=".json", delete=False) as handle:
            temporary = handle.name
            handle.write(raw)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if temporary and os.path.exists(temporary):
            os.unlink(temporary)


def load_sample(path: Path) -> SteamSample:
    return SteamSample.model_validate_json(path.read_bytes())


def load_progress(path: Path) -> LabelProgress:
    return LabelProgress.model_validate_json(path.read_bytes())


def validate_progress(sample: SteamSample, progress: LabelProgress) -> None:
    if (sample.dataset_id, sample.version, sample.tenant_id, sample.app_id) != (
        progress.dataset_id, progress.version, progress.tenant_id, progress.app_id
    ):
        raise ValueError("label progress belongs to a different sample")
    items = {item.id: item for item in sample.items}
    if not progress.labels.keys() <= items.keys():
        raise ValueError("label progress references a review outside this sample")
    for identifier, entry in progress.labels.items():
        item = items[identifier]
        if entry.review_sha256 != review_digest(item):
            raise ValueError("a labeled review changed; keep the original sample for reproducibility")
        labeled_example(item, progress, entry)


def labeled_example(item: SampleItem, progress: LabelProgress, entry: LabelEntry) -> EvalExample:
    return EvalExample.model_validate({
        "id": item.id, "synthetic": False, "case_type": entry.case_type, "text": item.text,
        "source": Source(name="Steam User Reviews", url=item.source_url,
                         published_at=item.created_at.date(), app_id=item.app_id,
                         external_id=item.external_id, language=item.language,
                         created_at=item.created_at, updated_at=item.updated_at,
                         voted_up=item.voted_up),
        "labeler": progress.labeler, "rights_basis": progress.rights_basis, "gold": entry.gold,
    })


def labeled_dataset(sample: SteamSample, progress: LabelProgress) -> EvalDataset:
    validate_progress(sample, progress)
    items = [labeled_example(item, progress, progress.labels[item.id])
             for item in sample.items if item.id in progress.labels]
    return EvalDataset(schema_version="review-quality-dataset-v2", dataset_id=sample.dataset_id,
                       version=sample.version, examples=items)


def length_group(text: str) -> Literal["short", "medium", "long"]:
    return "short" if len(text) < 100 else "medium" if len(text) < 500 else "long"


def deduplicate(items: list[SampleItem]) -> list[SampleItem]:
    by_key: dict[tuple[int, str], SampleItem] = {}
    for item in items:
        key = (item.app_id, item.external_id)
        previous = by_key.get(key)
        if previous is None or (item.updated_at, item.provenance == "tenant_document", item.id) > (
            previous.updated_at, previous.provenance == "tenant_document", previous.id
        ):
            by_key[key] = item
    return list(by_key.values())


def _by_length(items: list[SampleItem]) -> deque[SampleItem]:
    groups = {name: deque() for name in ("short", "medium", "long")}
    for item in sorted(items, key=lambda value: (value.created_at, value.external_id), reverse=True):
        groups[length_group(item.text)].append(item)
    ordered: deque[SampleItem] = deque()
    while any(groups.values()):
        for group in groups.values():
            if group:
                ordered.append(group.popleft())
    return ordered


def select_sample(items: list[SampleItem], limit: int, existing: list[SampleItem] | None = None) -> list[SampleItem]:
    if not 1 <= limit <= 50:
        raise ValueError("sample size must be between 1 and 50")
    kept = deduplicate(existing or [])
    if len(kept) > limit:
        raise ValueError("cannot shrink an existing sample; use a new dataset version")
    if len(kept) >= limit:
        return kept
    seen = {(item.app_id, item.external_id) for item in kept}
    pool = [item for item in deduplicate(items) if (item.app_id, item.external_id) not in seen]
    groups = {vote: _by_length([item for item in pool if item.voted_up == vote])
              for vote in (True, False)}
    selected = list(kept)
    vote_count = {vote: sum(item.voted_up == vote for item in kept) for vote in (True, False)}
    while len(selected) < limit and any(groups.values()):
        available = [vote for vote in (True, False) if groups[vote]]
        vote = min(available, key=lambda value: (vote_count[value], value))
        selected.append(groups[vote].popleft())
        vote_count[vote] += 1
    return selected


def from_database_row(app_id: int, row: tuple) -> SampleItem:
    external_id, body, language, created, updated, voted_up, origin = row
    return SampleItem(id=sample_id(app_id, external_id), app_id=app_id, external_id=external_id,
                      text=body, language=language, created_at=created, updated_at=updated,
                      source_url=origin, voted_up=voted_up, provenance="tenant_document")


def from_steam_review(app_id: int, review: SteamReview) -> SampleItem:
    return SampleItem(id=sample_id(app_id, review.recommendationid), app_id=app_id,
                      external_id=review.recommendationid, text=review.review, language=review.language,
                      created_at=datetime.fromtimestamp(review.timestamp_created, UTC),
                      updated_at=datetime.fromtimestamp(review.timestamp_updated, UTC),
                      source_url=f"https://store.steampowered.com/app/{app_id}/#app_reviews_hash",
                      voted_up=review.voted_up, provenance="steam_api")


def sample_counts(items: list[SampleItem]) -> dict[str, int]:
    return {"total": len(items), "positive_recommendations": sum(item.voted_up for item in items),
            "negative_recommendations": sum(not item.voted_up for item in items),
            "short": sum(length_group(item.text) == "short" for item in items),
            "medium": sum(length_group(item.text) == "medium" for item in items),
            "long": sum(length_group(item.text) == "long" for item in items)}


def label_counts(sample: SteamSample, progress: LabelProgress) -> dict[str, int]:
    decisions = [entry.gold.decision for entry in progress.labels.values()]
    return {"sampled": len(sample.items), "human_labeled": len(progress.labels),
            "remaining": len(sample.items) - len(progress.labels),
            "problem": decisions.count("problem"), "no_problem": decisions.count("no_problem"),
            "insufficient_evidence": decisions.count("insufficient_evidence"),
            "outside_taxonomy": sum(any(issue.category == "out_of_taxonomy" for issue in entry.gold.issues)
                                    for entry in progress.labels.values())}
