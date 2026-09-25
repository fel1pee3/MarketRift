"""Bounded official G2 syndication reader; no browser scraping or AI calls.

Production requires a G2-specific syndication credential and recorded rights.
The test transport is loopback-only and its rows are always sandbox_test.
"""

import asyncio
import json
import logging
import os
from datetime import UTC, datetime
from pathlib import Path
from urllib.parse import urlparse

import httpx
import psycopg
from jsonschema import Draft202012Validator, FormatChecker
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from .github_issues import rate_retry_at

SCHEMA = json.loads((Path(__file__).resolve().parents[3] /
                     "packages/contracts/sync-g2-reviews-job.v1.schema.json").read_text(encoding="utf-8"))
VALIDATOR = Draft202012Validator(SCHEMA, format_checker=FormatChecker())
OFFICIAL_ENDPOINT = "https://data.g2.com/api/2018-01-01/syndication/reviews"
# Syndication documentation places api_token in the query string. HTTP client
# INFO/DEBUG logs can include request URLs; suppress them in this worker.
logging.getLogger("httpx").disabled = True
logging.getLogger("httpcore").disabled = True


class G2Error(Exception):
    def __init__(self, code: str, retry_at: datetime | None = None):
        super().__init__(code)
        self.code = code
        self.retry_at = retry_at


class G2Attributes(BaseModel):
    model_config = ConfigDict(extra="ignore", strict=True)
    is_public: bool
    title: str | None = Field(default=None, max_length=500)
    url: str | None = Field(default=None, max_length=2000)
    answers: dict[str, object] | None = None
    published_at: datetime | None = None
    user_updated_at: datetime | None = None
    star_rating: float | None = Field(default=None, ge=0, le=5)
    language: str | None = Field(default=None, max_length=40)


class G2Review(BaseModel):
    model_config = ConfigDict(extra="ignore", strict=True)
    id: str = Field(pattern=r"^[A-Za-z0-9-]{1,100}$")
    attributes: G2Attributes


class G2Links(BaseModel):
    model_config = ConfigDict(extra="ignore", strict=True)
    next: str | None = None


class G2Meta(BaseModel):
    model_config = ConfigDict(extra="ignore", strict=True)
    page_count: int | None = Field(default=None, ge=0)


class G2Page(BaseModel):
    model_config = ConfigDict(extra="ignore", strict=True)
    data: list[G2Review] = Field(max_length=100)
    links: G2Links | None = None
    meta: G2Meta | None = None


def validate_job(payload: object) -> dict:
    VALIDATOR.validate(payload)
    assert isinstance(payload, dict)
    if payload["idempotency_key"] != f"g2-reviews-{payload['run_id']}-v1":
        raise G2Error("invalid_job_key")
    return payload


def endpoint(environment: str) -> str:
    testing = os.getenv("G2_TEST_BASE_URL") if os.getenv("MARKETRIFT_TEST_MODE") == "1" else None
    if testing:
        parsed = urlparse(testing)
        if (parsed.scheme != "http" or parsed.hostname != "127.0.0.1" or not parsed.port or
                parsed.username or parsed.password or parsed.path or parsed.query or parsed.fragment):
            raise G2Error("invalid_test_endpoint")
        return testing + "/api/2018-01-01/syndication/reviews"
    if environment == "sandbox":
        raise G2Error("sandbox_endpoint_unconfirmed")
    return OFFICIAL_ENDPOINT


def check_access(environment: str, token: str | None, storage_permitted: bool,
                 rights_reference: str | None, rights_expires_at: datetime | None,
                 test_transport: bool) -> None:
    if not token:
        raise G2Error("credential_missing")
    if environment == "sandbox" and not test_transport:
        raise G2Error("sandbox_endpoint_unconfirmed")
    if environment == "production" and not test_transport:
        if (os.getenv("G2_PRODUCTION_ENABLED") != "1" or not storage_permitted or
                not rights_reference or rights_expires_at is None or rights_expires_at <= datetime.now(UTC)):
            raise G2Error("rights_unconfirmed")


def review_text(review: G2Review) -> str:
    answers = review.attributes.answers or {}
    parts: list[str] = []
    for key in sorted(answers):
        entry = answers[key]
        if isinstance(entry, dict) and isinstance(entry.get("value"), str):
            value = entry["value"].strip()
            if value:
                parts.append(value)
    text = "\n\n".join(parts)
    if len(text) > 100000:
        raise G2Error("review_too_large")
    return text


def review_url(review: G2Review) -> str:
    value = review.attributes.url
    if not value:
        raise G2Error("review_url_missing")
    parsed = urlparse(value)
    if parsed.scheme != "https" or parsed.hostname != "www.g2.com" or parsed.username or parsed.password:
        raise G2Error("review_url_invalid")
    return value


async def fetch_reviews(product_id: str, start_page: int, max_pages: int, max_items: int,
                        token: str, environment: str, client: httpx.AsyncClient
                        ) -> tuple[list[G2Review], int, int, bool, str | None]:
    url = endpoint(environment)
    collected: list[G2Review] = []
    seen: set[str] = set()
    pages = received = 0
    next_page: str | None = None
    complete = False
    for page_no in range(start_page, start_page + max_pages):
        remaining = max_items - len(collected)
        if remaining <= 0:
            break
        params = {"filter[product_id]": product_id, "page[size]": min(20, remaining),
                  "page[number]": page_no, "api_token": token}
        for attempt in range(3):
            try:
                response = await client.get(url, params=params, headers={"Accept": "application/json"})
            except (httpx.TimeoutException, httpx.NetworkError) as error:
                if attempt == 2:
                    raise G2Error("network_failure") from None
                await asyncio.sleep(0.5 * 2**attempt)
                continue
            if response.status_code == 401:
                raise G2Error("credential_invalid")
            if response.status_code == 429 or (response.status_code == 403 and
                                                (response.headers.get("Retry-After") or
                                                 response.headers.get("x-ratelimit-remaining") == "0")):
                raise G2Error("rate_limited", rate_retry_at(response))
            if response.status_code == 403:
                raise G2Error("scope_or_product_access_denied")
            if response.status_code == 404:
                raise G2Error("product_not_found")
            if response.status_code >= 500:
                if attempt == 2:
                    raise G2Error("upstream_failure")
                await asyncio.sleep(0.5 * 2**attempt)
                continue
            if response.status_code != 200:
                raise G2Error("upstream_response")
            if len(response.content) > 5_000_000:
                raise G2Error("response_too_large")
            break
        try:
            result = G2Page.model_validate_json(response.content)
        except (ValueError, ValidationError, TypeError):
            raise G2Error("invalid_response") from None
        if result.links is None and (result.meta is None or result.meta.page_count is None):
            raise G2Error("pagination_unconfirmed")
        has_next = (result.links is not None and result.links.next is not None) or (
            result.meta is not None and result.meta.page_count is not None
            and page_no < result.meta.page_count)
        if not result.data and has_next:
            raise G2Error("pagination_stalled")
        pages += 1
        received += len(result.data)
        for review in result.data:
            if review.id not in seen:
                seen.add(review.id)
                collected.append(review)
        if not has_next:
            complete = True
            next_page = None
            break
        # Never follow links.next: G2 examples can embed api_token in that URL.
        next_page = str(page_no + 1)
        if len(collected) >= max_items:
            break
    return collected, received, pages, complete, next_page


async def _mark_failed(job: dict, error: G2Error) -> None:
    async with await psycopg.AsyncConnection.connect(os.environ["RUNTIME_DATABASE_URL"]) as connection:
        await connection.execute("SELECT set_config('app.tenant_id', %s, true)", (job["tenant_id"],))
        await connection.execute(
            "UPDATE marketrift.source_runs SET status = 'failed', error_code = %s, retry_after_at = %s, "
            "finished_at = now() WHERE tenant_id = %s AND source_id = %s AND id = %s AND status = 'running'",
            (error.code, error.retry_at, job["tenant_id"], job["source_id"], job["run_id"]),
        )
        if error.code in ("credential_invalid", "scope_or_product_access_denied", "product_not_found"):
            await connection.execute(
                "UPDATE marketrift.sources SET access_status = 'denied' "
                "WHERE tenant_id = %s AND id = %s AND source_type = 'g2'",
                (job["tenant_id"], job["source_id"]),
            )


async def sync_g2_reviews(payload: object, client: httpx.AsyncClient | None = None) -> dict:
    job = validate_job(payload)
    async with await psycopg.AsyncConnection.connect(os.environ["RUNTIME_DATABASE_URL"]) as connection:
        await connection.execute("SELECT set_config('app.tenant_id', %s, true)", (job["tenant_id"],))
        source = await (await connection.execute(
            "SELECT s.external_product_id, s.access_environment, s.storage_permitted, s.rights_reference, "
            "s.rights_expires_at, s.external_ai_permitted FROM marketrift.sources s "
            "JOIN marketrift.products p ON p.tenant_id = s.tenant_id AND p.id = s.product_id "
            "WHERE s.tenant_id = %s AND s.id = %s AND s.source_type = 'g2' AND s.enabled",
            (job["tenant_id"], job["source_id"]),
        )).fetchone()
        run = await (await connection.execute(
            "SELECT status, cursor_before, max_pages, max_items FROM marketrift.source_runs "
            "WHERE tenant_id = %s AND source_id = %s AND id = %s FOR UPDATE",
            (job["tenant_id"], job["source_id"], job["run_id"]),
        )).fetchone()
        if source is None or run is None or run[2] is None:
            raise G2Error("source_product_or_run_not_in_tenant")
        if run[0] != "pending":
            return {"status": run[0], "replayed": True}
        await connection.execute("UPDATE marketrift.source_runs SET status = 'running', started_at = now() WHERE id = %s",
                                 (job["run_id"],))

    owned_client = client is None
    if owned_client:
        client = httpx.AsyncClient(timeout=10, follow_redirects=False)
    assert client is not None
    try:
        token = os.getenv("G2_SYNDICATION_TOKEN")
        environment = source[1]
        test_transport = os.getenv("MARKETRIFT_TEST_MODE") == "1" and bool(os.getenv("G2_TEST_BASE_URL"))
        check_access(environment, token, source[2], source[3], source[4], test_transport)
        assert token is not None
        start_page = int(run[1]) if run[1] else 1
        if start_page < 1 or start_page > 100000:
            raise G2Error("invalid_cursor")
        reviews, received, pages, complete, next_page = await fetch_reviews(
            source[0], start_page, run[2], run[3], token, environment, client)
        new_count = updated_count = ignored = 0
        synthetic = environment == "sandbox" or test_transport
        async with await psycopg.AsyncConnection.connect(os.environ["RUNTIME_DATABASE_URL"]) as connection:
            await connection.execute("SELECT set_config('app.tenant_id', %s, true)", (job["tenant_id"],))
            locked = await (await connection.execute(
                "SELECT r.status FROM marketrift.source_runs r JOIN marketrift.sources s "
                "ON s.tenant_id = r.tenant_id AND s.id = r.source_id "
                "WHERE r.tenant_id = %s AND r.id = %s AND r.source_id = %s AND s.enabled "
                "AND s.source_type = 'g2' AND s.external_product_id = %s "
                "AND (%s OR (s.storage_permitted AND s.rights_reference IS NOT NULL "
                "AND s.rights_expires_at > now())) FOR UPDATE OF r, s",
                (job["tenant_id"], job["run_id"], job["source_id"], source[0], test_transport),
            )).fetchone()
            if locked is None or locked[0] != "running":
                raise G2Error("run_state_changed")
            for review in reviews:
                attrs = review.attributes
                if not attrs.is_public:
                    await connection.execute(
                        "DELETE FROM marketrift.insights WHERE tenant_id = %s AND document_id IN "
                        "(SELECT id FROM marketrift.documents WHERE tenant_id = %s AND source_id = %s AND external_key = %s)",
                        (job["tenant_id"], job["tenant_id"], job["source_id"], review.id),
                    )
                    removed = await connection.execute(
                        "DELETE FROM marketrift.documents WHERE tenant_id = %s AND source_id = %s "
                        "AND external_key = %s AND document_type = 'g2_review'",
                        (job["tenant_id"], job["source_id"], review.id),
                    )
                    ignored += removed.rowcount or 0
                    continue
                body = review_text(review)
                if not body or attrs.published_at is None:
                    ignored += 1
                    continue
                origin = review_url(review)
                data_status = "sandbox_test" if synthetic else "declared_real"
                existing = await (await connection.execute(
                    "SELECT id, body, source_updated_at, source_url, review_rating FROM marketrift.documents "
                    "WHERE tenant_id = %s AND source_id = %s AND external_key = %s",
                    (job["tenant_id"], job["source_id"], review.id),
                )).fetchone()
                updated_at = attrs.user_updated_at or attrs.published_at
                if existing is None:
                    inserted = await (await connection.execute(
                        "INSERT INTO marketrift.documents (tenant_id, source_id, document_type, external_key, "
                        "source_url, body, source_title, published_at, source_created_at, source_updated_at, "
                        "review_language, review_rating, review_data_status, synthetic) "
                        "VALUES (%s, %s, 'g2_review', %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s) "
                        "ON CONFLICT (tenant_id, source_id, external_key) DO NOTHING RETURNING id",
                        (job["tenant_id"], job["source_id"], review.id, origin, body, attrs.title,
                         attrs.published_at, attrs.published_at, updated_at, attrs.language,
                         attrs.star_rating, data_status, synthetic),
                    )).fetchone()
                    new_count += bool(inserted)
                elif existing[2] is None or updated_at >= existing[2]:
                    if (existing[1], existing[2], existing[3], existing[4]) != (
                            body, updated_at, origin, attrs.star_rating):
                        await connection.execute(
                            "UPDATE marketrift.documents SET body = %s, source_title = %s, source_url = %s, "
                            "source_updated_at = %s, review_language = %s, review_rating = %s, "
                            "collected_at = now() WHERE tenant_id = %s AND id = %s",
                            (body, attrs.title, origin, updated_at, attrs.language, attrs.star_rating,
                             job["tenant_id"], existing[0]),
                        )
                        updated_count += 1
                    else:
                        ignored += 1
                else:
                    ignored += 1
            await connection.execute(
                "UPDATE marketrift.source_runs SET status = 'succeeded', documents_seen = %s, "
                "documents_new = %s, documents_updated = %s, documents_ignored = %s, pages_fetched = %s, "
                "scan_complete = %s, cursor_after = %s, finished_at = now() "
                "WHERE tenant_id = %s AND id = %s",
                (received, new_count, updated_count, ignored, pages, complete, next_page,
                 job["tenant_id"], job["run_id"]),
            )
            await connection.execute(
                "UPDATE marketrift.sources SET last_checked_at = now(), access_status = %s "
                "WHERE tenant_id = %s AND id = %s",
                ("sandbox_only" if synthetic else "authorized", job["tenant_id"], job["source_id"]),
            )
        return {"status": "succeeded", "documents_seen": received, "documents_new": new_count,
                "documents_updated": updated_count, "scan_complete": complete}
    except G2Error as error:
        await _mark_failed(job, error)
        return {"status": "failed", "error_code": error.code}
    except Exception:  # noqa: BLE001 - never put response URLs or provider text in BullMQ errors
        await _mark_failed(job, G2Error("worker_failure"))
        return {"status": "failed", "error_code": "worker_failure"}
    finally:
        if owned_client:
            await client.aclose()
