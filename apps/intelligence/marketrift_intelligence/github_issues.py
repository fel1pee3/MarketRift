"""Bounded public GitHub Issues collection. No review extraction or paid model calls."""

import asyncio
import json
import os
import re
from datetime import UTC, datetime, timedelta
from email.utils import parsedate_to_datetime
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import httpx
import psycopg
from jsonschema import Draft202012Validator, FormatChecker
from pydantic import BaseModel, ConfigDict, Field, ValidationError

SCHEMA = json.loads((Path(__file__).resolve().parents[3] /
                     "packages/contracts/sync-github-issues-job.v1.schema.json").read_text(encoding="utf-8"))
VALIDATOR = Draft202012Validator(SCHEMA, format_checker=FormatChecker())
REPOSITORY = re.compile(r"^https://github\.com/([A-Za-z0-9][A-Za-z0-9-]{0,38})/([A-Za-z0-9_.-]{1,100})$")
HEADERS = {"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28",
           "User-Agent": "MarketRift-public-issues-connector"}


class GitHubIssue(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: int = Field(gt=0)
    number: int = Field(gt=0)
    html_url: str
    title: str = Field(min_length=1, max_length=1000)
    body: str | None = Field(default=None, max_length=100000)
    created_at: datetime
    updated_at: datetime
    state: str


class CollectionError(Exception):
    def __init__(self, code: str, retry_at: datetime | None = None):
        super().__init__(code)
        self.code = code
        self.retry_at = retry_at


def repository_parts(url: str) -> tuple[str, str]:
    match = REPOSITORY.fullmatch(url)
    if not match or match.group(2) in (".", ".."):
        raise CollectionError("invalid_source_url")
    return match.group(1), match.group(2)


def validate_job(payload: object) -> dict:
    VALIDATOR.validate(payload)
    assert isinstance(payload, dict)
    if payload["idempotency_key"] != f"github-issues-{payload['run_id']}-v1":
        raise CollectionError("invalid_job_key")
    return payload


def rate_retry_at(response: httpx.Response) -> datetime:
    now = datetime.now(UTC)
    retry = response.headers.get("Retry-After", "")
    if retry.isdigit():
        return now + timedelta(seconds=max(int(retry), 1))
    if retry:
        try:
            return max(now + timedelta(seconds=1), parsedate_to_datetime(retry).astimezone(UTC))
        except (TypeError, ValueError):
            pass
    if response.headers.get("x-ratelimit-remaining") == "0":
        reset = response.headers.get("x-ratelimit-reset", "")
        if reset.isdigit():
            return max(now + timedelta(seconds=1), datetime.fromtimestamp(int(reset), UTC))
    return now + timedelta(seconds=60)


def has_next(link_header: str, api_path: str, page: int) -> bool:
    for part in link_header.split(","):
        if 'rel="next"' not in part:
            continue
        match = re.search(r"<([^>]+)>", part)
        if not match:
            raise CollectionError("invalid_pagination_link")
        url = urlparse(match.group(1))
        params = parse_qs(url.query)
        if (url.scheme != "https" or url.netloc != "api.github.com" or url.path.lower() != api_path.lower()
                or params.get("page") != [str(page + 1)]):
            raise CollectionError("invalid_pagination_link")
        return True
    return False


async def fetch_issues(repository_url: str, cursor: str | None, max_pages: int, max_items: int,
                       client: httpx.AsyncClient) -> tuple[list[GitHubIssue], int, int, str | None]:
    owner, repo = repository_parts(repository_url)
    api_path = f"/repos/{owner}/{repo}/issues"
    result: list[GitHubIssue] = []
    skipped = 0
    pages = 0
    latest = datetime.fromisoformat(cursor) if cursor else None
    since = (latest - timedelta(seconds=60)).isoformat().replace("+00:00", "Z") if latest else None
    for page in range(1, max_pages + 1):
        params: dict[str, str | int] = {"state": "all", "sort": "updated",
                                        "direction": "asc" if since else "desc",
                                        "per_page": min(max_items, 50), "page": page}
        if since:
            params["since"] = since
        for attempt in range(3):
            try:
                response = await client.get(f"https://api.github.com{api_path}", params=params, headers=HEADERS)
            except (httpx.TimeoutException, httpx.NetworkError) as error:
                if attempt == 2:
                    raise CollectionError("network_failure") from error
                await asyncio.sleep(0.5 * 2**attempt)
                continue
            if response.status_code in (403, 429):
                try:
                    message = str(response.json().get("message", "")).lower()
                except (ValueError, AttributeError):
                    message = ""
                if (response.status_code == 429 or response.headers.get("Retry-After")
                        or response.headers.get("x-ratelimit-remaining") == "0"
                        or "secondary rate limit" in message):
                    raise CollectionError("rate_limited", rate_retry_at(response))
                raise CollectionError("forbidden")
            if response.status_code == 404:
                raise CollectionError("repository_not_found")
            if response.status_code >= 500:
                if attempt == 2:
                    raise CollectionError("upstream_failure")
                await asyncio.sleep(0.5 * 2**attempt)
                continue
            if response.status_code != 200:
                raise CollectionError("upstream_response")
            if len(response.content) > 5_000_000:
                raise CollectionError("response_too_large")
            break
        pages += 1
        try:
            payload = response.json()
            if not isinstance(payload, list):
                raise TypeError("not a list")
            for item in payload:
                if not isinstance(item, dict):
                    raise TypeError("not an object")
                if "pull_request" in item:
                    skipped += 1
                    continue
                issue = GitHubIssue.model_validate(item)
                expected = f"https://github.com/{owner}/{repo}/issues/{issue.number}"
                if issue.html_url.lower() != expected.lower() or issue.state not in ("open", "closed"):
                    raise ValueError("invalid issue provenance")
                result.append(issue)
                if latest is None or issue.updated_at > latest:
                    latest = issue.updated_at
                if len(result) >= max_items:
                    break
        except (ValueError, ValidationError, TypeError) as error:
            raise CollectionError("invalid_issue_payload") from error
        if len(result) >= max_items or not has_next(response.headers.get("link", ""), api_path, page):
            break
    return result, pages, skipped, latest.isoformat() if latest else cursor


async def _finish_failed(job: dict, error: CollectionError) -> None:
    async with await psycopg.AsyncConnection.connect(os.environ["RUNTIME_DATABASE_URL"]) as connection:
        await connection.execute("SELECT set_config('app.tenant_id', %s, true)", (job["tenant_id"],))
        await connection.execute(
            "UPDATE marketrift.source_runs SET status = 'failed', error_code = %s, retry_after_at = %s, "
            "finished_at = now() WHERE tenant_id = %s AND id = %s AND source_id = %s AND status = 'running'",
            (error.code, error.retry_at, job["tenant_id"], job["run_id"], job["source_id"]),
        )


async def sync_github_issues(payload: object, client: httpx.AsyncClient | None = None) -> dict:
    job = validate_job(payload)
    async with await psycopg.AsyncConnection.connect(os.environ["RUNTIME_DATABASE_URL"]) as connection:
        await connection.execute("SELECT set_config('app.tenant_id', %s, true)", (job["tenant_id"],))
        source = await (await connection.execute(
            "SELECT url FROM marketrift.sources WHERE tenant_id = %s AND id = %s "
            "AND source_type = 'github_issues' AND enabled = true",
            (job["tenant_id"], job["source_id"]),
        )).fetchone()
        run = await (await connection.execute(
            "SELECT status, cursor_before, max_pages, max_items FROM marketrift.source_runs "
            "WHERE tenant_id = %s AND id = %s AND source_id = %s FOR UPDATE",
            (job["tenant_id"], job["run_id"], job["source_id"]),
        )).fetchone()
        if source is None or run is None or run[2] is None:
            raise CollectionError("source_or_run_not_in_tenant")
        if run[0] == "succeeded":
            return {"status": "succeeded", "replayed": True}
        if run[0] != "pending":
            return {"status": run[0], "replayed": True}
        await connection.execute(
            "UPDATE marketrift.source_runs SET status = 'running', started_at = now() WHERE id = %s",
            (job["run_id"],),
        )
    owned_client = client is None
    if owned_client:
        client = httpx.AsyncClient(timeout=10, follow_redirects=False)
    assert client is not None
    try:
        repository_parts(source[0])
        issues, pages, skipped, cursor_after = await fetch_issues(source[0], run[1], run[2], run[3], client)
        owner, repo = repository_parts(source[0])
        repository = f"{owner}/{repo}"
        new_count = 0
        updated_count = 0
        async with await psycopg.AsyncConnection.connect(os.environ["RUNTIME_DATABASE_URL"]) as connection:
            await connection.execute("SELECT set_config('app.tenant_id', %s, true)", (job["tenant_id"],))
            locked = await (await connection.execute(
                "SELECT status FROM marketrift.source_runs WHERE tenant_id = %s AND id = %s AND source_id = %s FOR UPDATE",
                (job["tenant_id"], job["run_id"], job["source_id"]),
            )).fetchone()
            if locked is None or locked[0] != "running":
                raise CollectionError("run_state_changed")
            for issue in issues:
                original_body = issue.body or ""
                display_body = issue.title + ("\n\n" + original_body if original_body else "")
                existing = await (await connection.execute(
                    "SELECT source_url, source_title, source_body, source_updated_at, source_state "
                    "FROM marketrift.documents WHERE tenant_id = %s AND source_id = %s AND external_key = %s",
                    (job["tenant_id"], job["source_id"], str(issue.id)),
                )).fetchone()
                if existing is None:
                    await connection.execute(
                        "INSERT INTO marketrift.documents (tenant_id, source_id, document_type, external_key, "
                        "source_url, body, published_at, source_title, source_body, source_created_at, "
                        "source_updated_at, source_state, source_repository) "
                        "VALUES (%s, %s, 'github_issue', %s, %s, %s, %s, %s, %s, %s, %s, %s, %s) "
                        "ON CONFLICT (tenant_id, source_id, external_key) DO NOTHING",
                        (job["tenant_id"], job["source_id"], str(issue.id), issue.html_url,
                         display_body, issue.created_at, issue.title, original_body, issue.created_at,
                         issue.updated_at, issue.state, repository),
                    )
                    new_count += 1
                elif (existing[3] is None or issue.updated_at >= existing[3]) and (
                    (existing[0], existing[1], existing[2], existing[3], existing[4]) !=
                    (issue.html_url, issue.title, original_body, issue.updated_at, issue.state)
                ):
                    await connection.execute(
                        "UPDATE marketrift.documents SET source_url = %s, body = %s, source_title = %s, "
                        "source_body = %s, source_updated_at = %s, source_state = %s, collected_at = now() "
                        "WHERE tenant_id = %s AND source_id = %s AND external_key = %s",
                        (issue.html_url, display_body, issue.title, original_body, issue.updated_at,
                         issue.state, job["tenant_id"], job["source_id"], str(issue.id)),
                    )
                    updated_count += 1
            await connection.execute(
                "UPDATE marketrift.source_runs SET status = 'succeeded', cursor_after = %s, "
                "documents_seen = %s, documents_new = %s, documents_updated = %s, pages_fetched = %s, "
                "pull_requests_skipped = %s, finished_at = now() WHERE id = %s",
                (cursor_after, len(issues), new_count, updated_count, pages, skipped, job["run_id"]),
            )
            await connection.execute(
                "UPDATE marketrift.sources SET last_checked_at = now() WHERE tenant_id = %s AND id = %s",
                (job["tenant_id"], job["source_id"]),
            )
        return {"status": "succeeded", "seen": len(issues), "new": new_count, "updated": updated_count}
    except CollectionError as error:
        await _finish_failed(job, error)
        return {"status": "failed", "error_code": error.code}
    except Exception:
        await _finish_failed(job, CollectionError("internal_failure"))
        raise
    finally:
        if owned_client:
            await client.aclose()
