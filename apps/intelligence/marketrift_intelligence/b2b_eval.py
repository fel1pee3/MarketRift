"""Private, human-labeled B2B review samples. No model calls or tenant writes."""

import hashlib
import json
import os
from datetime import datetime
from pathlib import Path
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, HttpUrl, model_validator
import psycopg

from .quality_eval import EvalDataset, EvalExample, GoldLabel, Source
from .steam_eval import LabelEntry, private_path, write_json_atomic

PRIVATE_ROOT = Path(__file__).resolve().parents[3] / "evalsets/private"
DEFAULT_SAMPLE = PRIVATE_ROOT / "b2b-sample-v1.json"
DEFAULT_PROGRESS = PRIVATE_ROOT / "b2b-labels-v1.json"
DEFAULT_DATASET = PRIVATE_ROOT / "b2b-reviews-v1.json"


def item_id(source_id: UUID, external_key: str) -> str:
    digest = hashlib.sha256(f"{source_id}:{external_key}".encode()).hexdigest()[:16]
    return f"b2b-{digest}"


class B2BItem(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    id: str = Field(pattern=r"^b2b-[0-9a-f]{16}$")
    tenant_id: UUID
    source_id: UUID
    document_id: UUID
    external_key: str = Field(min_length=1, max_length=200)
    text: str = Field(min_length=1, max_length=10000)
    source_url: HttpUrl
    published_at: datetime | None = None
    language: str | None = Field(default=None, min_length=2, max_length=40)
    synthetic: bool
    review_data_status: Literal["declared_real", "synthetic_fixture"]

    @model_validator(mode="after")
    def consistent(self):
        if self.id != item_id(self.source_id, self.external_key):
            raise ValueError("inconsistent sample ID")
        if self.synthetic != (self.review_data_status == "synthetic_fixture"):
            raise ValueError("sample provenance mismatch")
        if self.published_at and self.published_at.tzinfo is None:
            raise ValueError("published_at needs timezone")
        return self


class B2BSample(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    schema_version: Literal["b2b-review-sample-v1"] = "b2b-review-sample-v1"
    dataset_id: str = Field(pattern=r"^[a-z0-9][a-z0-9-]{0,79}$")
    version: str = Field(pattern=r"^[0-9]+\.[0-9]+\.[0-9]+$")
    tenant_id: UUID
    source_id: UUID
    synthetic: bool
    items: list[B2BItem] = Field(max_length=50)

    @model_validator(mode="after")
    def unique(self):
        if len({item.external_key for item in self.items}) != len(self.items):
            raise ValueError("duplicate review in sample")
        if any(item.tenant_id != self.tenant_id or item.source_id != self.source_id
               or item.synthetic != self.synthetic for item in self.items):
            raise ValueError("sample scope mismatch")
        return self


class B2BProgress(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    schema_version: Literal["b2b-human-labels-v1"] = "b2b-human-labels-v1"
    dataset_id: str
    version: str
    tenant_id: UUID
    source_id: UUID
    labeler: str = Field(pattern=r"^human:[a-z0-9][a-z0-9-]{0,59}$")
    rights_basis: str = Field(min_length=8, max_length=500)
    labels: dict[str, LabelEntry] = Field(default_factory=dict)


def item_digest(item: B2BItem) -> str:
    raw = json.dumps(item.model_dump(mode="json"), ensure_ascii=False, sort_keys=True)
    return hashlib.sha256(raw.encode()).hexdigest()


def select_items(candidates: list[B2BItem], limit: int, kept: list[B2BItem] | None = None) -> list[B2BItem]:
    if not 1 <= limit <= 50:
        raise ValueError("sample limit must be 1-50")
    selected = list(kept or [])
    if len(selected) > limit:
        raise ValueError("cannot shrink existing sample")
    seen = {item.external_key for item in selected}
    for item in sorted(candidates, key=lambda row: (len(row.text), row.external_key)):
        if item.external_key not in seen and len(selected) < limit:
            selected.append(item)
            seen.add(item.external_key)
    return selected


def labeled_example(item: B2BItem, progress: B2BProgress, entry: LabelEntry) -> EvalExample:
    return EvalExample(id=item.id, synthetic=item.synthetic, case_type=entry.case_type,
                       text=item.text, source=Source(kind="b2b_csv", name="B2B CSV autorizado",
                       url=item.source_url, published_at=item.published_at.date() if item.published_at else None,
                       language=item.language, tenant_id=item.tenant_id, source_id=item.source_id,
                       document_id=item.document_id, external_key=item.external_key),
                       labeler="synthetic-fixture" if item.synthetic else progress.labeler,
                       rights_basis=progress.rights_basis, gold=entry.gold)


def labeled_dataset(sample: B2BSample, progress: B2BProgress) -> EvalDataset:
    if (sample.dataset_id, sample.version, sample.tenant_id, sample.source_id) != (
        progress.dataset_id, progress.version, progress.tenant_id, progress.source_id):
        raise ValueError("label progress belongs to another sample")
    by_id = {item.id: item for item in sample.items}
    if not progress.labels.keys() <= by_id.keys():
        raise ValueError("label references review outside sample")
    examples = []
    for item in sample.items:
        entry = progress.labels.get(item.id)
        if entry:
            if entry.review_sha256 != item_digest(item):
                raise ValueError("labeled review changed")
            examples.append(labeled_example(item, progress, entry))
    return EvalDataset(schema_version="review-quality-dataset-v2", dataset_id=sample.dataset_id,
                       version=sample.version, examples=examples)


def load_sample(path: Path) -> B2BSample:
    return B2BSample.model_validate_json(private_path(path).read_bytes())


def load_progress(path: Path) -> B2BProgress:
    return B2BProgress.model_validate_json(private_path(path).read_bytes())


async def extract_with_current_rights(example: EvalExample, extractor):
    """Hold the source read lock across the paid call so revocation cannot race it."""
    scope = example.source
    if scope.kind != "b2b_csv" or example.synthetic or not all(
            (scope.tenant_id, scope.source_id, scope.document_id, scope.external_key)):
        raise PermissionError("ExternalAIRightsUnavailable")
    async with await psycopg.AsyncConnection.connect(os.environ["RUNTIME_DATABASE_URL"]) as connection:
        async with connection.transaction():
            await connection.execute("SELECT set_config('app.tenant_id', %s, true)",
                                     (str(scope.tenant_id),))
            row = await (await connection.execute(
                "SELECT d.body FROM marketrift.documents d JOIN marketrift.sources s "
                "ON s.tenant_id = d.tenant_id AND s.id = d.source_id "
                "WHERE d.tenant_id = %s AND d.source_id = %s AND d.id = %s "
                "AND d.external_key = %s AND d.document_type = 'b2b_review' "
                "AND NOT d.synthetic AND d.review_data_status = 'declared_real' "
                "AND s.source_type = 'b2b_csv_review' AND s.access_environment = 'production' "
                "AND s.enabled AND s.storage_permitted AND s.external_ai_permitted "
                "AND s.ai_provider = 'openai' AND s.ai_rights_reference IS NOT NULL "
                "AND s.ai_rights_expires_at > now() AND s.ai_rights_revoked_at IS NULL "
                "FOR SHARE OF s, d",
                (scope.tenant_id, scope.source_id, scope.document_id, scope.external_key),
            )).fetchone()
            if not row or row[0] != example.text:
                raise PermissionError("ExternalAIRightsUnavailable")
            return await extractor(example.text)
