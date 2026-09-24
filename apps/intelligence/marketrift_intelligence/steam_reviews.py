"""Small, manual Steam review sync through the documented JSON endpoint."""

import asyncio
import json
import os
import re
from datetime import UTC, datetime, timedelta
from pathlib import Path
from urllib.parse import urlparse

import httpx
import psycopg
from jsonschema import Draft202012Validator, FormatChecker
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from .github_issues import rate_retry_at

SCHEMA = json.loads((Path(__file__).resolve().parents[3] /
                     "packages/contracts/sync-steam-reviews-job.v1.schema.json").read_text(encoding="utf-8"))
VALIDATOR = Draft202012Validator(SCHEMA, format_checker=FormatChecker())
SOURCE_URL = re.compile(r"^https://store\.steampowered\.com/app/([1-9][0-9]{0,9})/$")
OVERLAP = timedelta(hours=24)
HEADERS = {"Accept": "application/json", "User-Agent": "MarketRift-public-review-pilot"}


class SteamReview(BaseModel):
    model_config = ConfigDict(extra="ignore", strict=True)
    recommendationid: str = Field(pattern=r"^[1-9][0-9]{0,29}$")
    review: str = Field(max_length=100000)
    language: str = Field(min_length=2, max_length=40, pattern=r"^[A-Za-z_-]+$")
    timestamp_created: int = Field(ge=1, le=4102444800)
    timestamp_updated: int = Field(ge=1, le=4102444800)
    voted_up: bool


class SteamResponse(BaseModel):
    model_config = ConfigDict(extra="ignore", strict=True)
    success: int
    cursor: str = Field(max_length=4096)
    reviews: list[SteamReview] = Field(max_length=100)


class SteamCollectionError(Exception):
    def __init__(self, code: str, retry_at: datetime | None = None):
        super().__init__(code)
        self.code = code
        self.retry_at = retry_at


def app_id_from_source(url: str) -> int:
    match = SOURCE_URL.fullmatch(url)
    if not match or int(match.group(1)) > 4294967295:
        raise SteamCollectionError("invalid_source_url")
    return int(match.group(1))


def validate_job(payload: object) -> dict:
    VALIDATOR.validate(payload)
    assert isinstance(payload, dict)
    if payload["idempotency_key"] != f"steam-reviews-{payload['run_id']}-v1":
        raise SteamCollectionError("invalid_job_key")
    return payload


def endpoint(app_id: int) -> str:
    # Production cannot change this host. A loopback substitute is only for the E2E process.
    testing = os.getenv("STEAM_REVIEW_TEST_BASE_URL") if os.getenv("MARKETRIFT_TEST_MODE") == "1" else None
    if testing:
        parsed = urlparse(testing)
        if (parsed.scheme != "http" or parsed.hostname != "127.0.0.1" or not parsed.port or
                parsed.username or parsed.password or parsed.path or parsed.query or parsed.fragment):
            raise SteamCollectionError("invalid_test_endpoint")
        return f"{testing}/appreviews/{app_id}"
    return f"https://store.steampowered.com/appreviews/{app_id}"


async def fetch_reviews(app_id: int, previous_cursor: str | None, max_pages: int, max_items: int,
                        client: httpx.AsyncClient) -> tuple[list[SteamReview], int, int, int, bool, str | None]:
    previous = datetime.fromisoformat(previous_cursor) if previous_cursor else None
    cutoff = previous - OVERLAP if previous else None
    filter_name = "updated" if previous else "recent"
    cursor = "*"
    collected: list[SteamReview] = []
    received = ignored = pages = 0
    seen_ids: set[str] = set()
    seen_cursors = {cursor}
    latest = previous
    complete = False
    for _ in range(max_pages):
        params = {"json": 1, "filter": filter_name, "language": "all", "review_type": "all",
                  "purchase_type": "all", "num_per_page": min(20, max_items - len(collected)), "cursor": cursor}
        for attempt in range(3):
            try:
                response = await client.get(endpoint(app_id), params=params, headers=HEADERS)
            except (httpx.TimeoutException, httpx.NetworkError) as error:
                if attempt == 2:
                    raise SteamCollectionError("network_failure") from error
                await asyncio.sleep(0.5 * 2**attempt)
                continue
            if response.status_code == 429 or (response.status_code == 403 and
                                                (response.headers.get("Retry-After") or
                                                 response.headers.get("x-ratelimit-remaining") == "0")):
                raise SteamCollectionError("rate_limited", rate_retry_at(response))
            if response.status_code in (404, 410):
                raise SteamCollectionError("product_not_found")
            if response.status_code == 403:
                raise SteamCollectionError("forbidden")
            if response.status_code >= 500:
                if attempt == 2:
                    raise SteamCollectionError("upstream_failure")
                await asyncio.sleep(0.5 * 2**attempt)
                continue
            if response.status_code != 200:
                raise SteamCollectionError("upstream_response")
            if len(response.content) > 5_000_000:
                raise SteamCollectionError("response_too_large")
            break
        pages += 1
        try:
            raw = response.json()
            page = SteamResponse.model_validate(raw)
        except (ValueError, ValidationError, TypeError) as error:
            raise SteamCollectionError("invalid_response") from error
        if page.success != 1:
            raise SteamCollectionError("product_unavailable_or_invalid")
        if not page.reviews:
            complete = True
            break
        received += len(page.reviews)
        old_on_page = 0
        for review in page.reviews:
            updated = datetime.fromtimestamp(review.timestamp_updated, UTC)
            if cutoff and updated < cutoff:
                ignored += 1
                old_on_page += 1
                continue
            if not review.review.strip() or review.recommendationid in seen_ids or len(collected) >= max_items:
                ignored += 1
                continue
            seen_ids.add(review.recommendationid)
            collected.append(review)
            if latest is None or updated > latest:
                latest = updated
        if old_on_page == len(page.reviews):
            complete = True
            break
        if len(collected) >= max_items:
            break
        if not page.cursor or page.cursor in seen_cursors:
            raise SteamCollectionError("pagination_stalled")
        seen_cursors.add(page.cursor)
        cursor = page.cursor
    return collected, received, pages, ignored, complete, latest.isoformat() if latest else previous_cursor


async def _mark_failed(job: dict, error: SteamCollectionError) -> None:
    async with await psycopg.AsyncConnection.connect(os.environ["RUNTIME_DATABASE_URL"]) as connection:
        await connection.execute("SELECT set_config('app.tenant_id', %s, true)", (job["tenant_id"],))
        await connection.execute(
            "UPDATE marketrift.source_runs SET status = 'failed', error_code = %s, retry_after_at = %s, "
            "finished_at = now() WHERE tenant_id = %s AND source_id = %s AND id = %s AND status = 'running'",
            (error.code, error.retry_at, job["tenant_id"], job["source_id"], job["run_id"]),
        )


async def sync_steam_reviews(payload: object, client: httpx.AsyncClient | None = None) -> dict:
    job = validate_job(payload)
    async with await psycopg.AsyncConnection.connect(os.environ["RUNTIME_DATABASE_URL"]) as connection:
        await connection.execute("SELECT set_config('app.tenant_id', %s, true)", (job["tenant_id"],))
        source = await (await connection.execute(
            "SELECT s.url, s.product_id FROM marketrift.sources s "
            "JOIN marketrift.products p ON p.tenant_id = s.tenant_id AND p.id = s.product_id "
            "WHERE s.tenant_id = %s AND s.id = %s AND s.source_type = 'steam_reviews' AND s.enabled = true",
            (job["tenant_id"], job["source_id"]),
        )).fetchone()
        run = await (await connection.execute(
            "SELECT status, cursor_before, max_pages, max_items FROM marketrift.source_runs "
            "WHERE tenant_id = %s AND source_id = %s AND id = %s FOR UPDATE",
            (job["tenant_id"], job["source_id"], job["run_id"]),
        )).fetchone()
        if source is None or run is None or run[2] is None:
            raise SteamCollectionError("source_product_or_run_not_in_tenant")
        if run[0] != "pending":
            return {"status": run[0], "replayed": True}
        await connection.execute("UPDATE marketrift.source_runs SET status = 'running', started_at = now() WHERE id = %s",
                                 (job["run_id"],))
    owned_client = client is None
    if owned_client:
        client = httpx.AsyncClient(timeout=10, follow_redirects=False)
    assert client is not None
    try:
        app_id = app_id_from_source(source[0])
        reviews, received, pages, ignored, complete, cursor_after = await fetch_reviews(
            app_id, run[1], run[2], run[3], client)
        new_count = updated_count = 0
        # The API does not document a reliable review permalink without author identity.
        origin = f"https://store.steampowered.com/app/{app_id}/#app_reviews_hash"
        async with await psycopg.AsyncConnection.connect(os.environ["RUNTIME_DATABASE_URL"]) as connection:
            await connection.execute("SELECT set_config('app.tenant_id', %s, true)", (job["tenant_id"],))
            locked = await (await connection.execute(
                "SELECT status FROM marketrift.source_runs WHERE tenant_id = %s AND source_id = %s "
                "AND id = %s FOR UPDATE", (job["tenant_id"], job["source_id"], job["run_id"]),
            )).fetchone()
            if locked is None or locked[0] != "running":
                raise SteamCollectionError("run_state_changed")
            for review in reviews:
                created_at = datetime.fromtimestamp(review.timestamp_created, UTC)
                updated_at = datetime.fromtimestamp(review.timestamp_updated, UTC)
                existing = await (await connection.execute(
                    "SELECT id, body, source_updated_at, review_language, review_voted_up "
                    "FROM marketrift.documents WHERE tenant_id = %s AND source_id = %s AND external_key = %s",
                    (job["tenant_id"], job["source_id"], review.recommendationid),
                )).fetchone()
                if existing is None:
                    inserted = await (await connection.execute(
                        "INSERT INTO marketrift.documents (tenant_id, source_id, document_type, external_key, "
                        "source_url, source_url_kind, body, published_at, source_created_at, source_updated_at, "
                        "steam_app_id, review_language, review_voted_up, synthetic) "
                        "VALUES (%s, %s, 'steam_review', %s, %s, 'product_reviews', %s, %s, %s, %s, %s, %s, %s, false) "
                        "ON CONFLICT (tenant_id, source_id, external_key) DO NOTHING RETURNING id",
                        (job["tenant_id"], job["source_id"], review.recommendationid, origin, review.review,
                         created_at, created_at, updated_at, app_id, review.language, review.voted_up),
                    )).fetchone()
                    if inserted:
                        new_count += 1
                    else:
                        ignored += 1
                elif (existing[2] is None or updated_at >= existing[2]) and (
                    existing[1], existing[2], existing[3], existing[4]) != (
                    review.review, updated_at, review.language, review.voted_up):
                    await connection.execute(
                        "UPDATE marketrift.documents SET body = %s, source_updated_at = %s, "
                        "review_language = %s, review_voted_up = %s, collected_at = now() "
                        "WHERE tenant_id = %s AND source_id = %s AND id = %s",
                        (review.review, updated_at, review.language, review.voted_up,
                         job["tenant_id"], job["source_id"], existing[0]),
                    )
                    if existing[1] != review.review:
                        # Hide stale claims; a user must explicitly ask for a new analysis.
                        await connection.execute(
                            "UPDATE marketrift.document_analyses SET status = 'pending', queued_at = now(), "
                            "last_error = NULL WHERE tenant_id = %s AND document_id = %s",
                            (job["tenant_id"], existing[0]),
                        )
                    updated_count += 1
                else:
                    ignored += 1
            await connection.execute(
                "UPDATE marketrift.source_runs SET status = 'succeeded', cursor_after = %s, "
                "documents_seen = %s, documents_new = %s, documents_updated = %s, documents_ignored = %s, "
                "pages_fetched = %s, scan_complete = %s, finished_at = now() WHERE id = %s",
                (cursor_after, received, new_count, updated_count, ignored, pages, complete, job["run_id"]),
            )
            await connection.execute("UPDATE marketrift.sources SET last_checked_at = now() "
                                     "WHERE tenant_id = %s AND id = %s", (job["tenant_id"], job["source_id"]))
        return {"status": "succeeded", "received": received, "new": new_count,
                "updated": updated_count, "ignored": ignored, "scan_complete": complete}
    except SteamCollectionError as error:
        await _mark_failed(job, error)
        return {"status": "failed", "error_code": error.code}
    except Exception:
        await _mark_failed(job, SteamCollectionError("internal_failure"))
        raise
    finally:
        if owned_client:
            await client.aclose()
