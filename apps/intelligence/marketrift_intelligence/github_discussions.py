"""Bounded public GitHub Discussions GraphQL connector; no AI calls."""

import asyncio
import json
import os
import re
from datetime import datetime
from pathlib import Path
from urllib.parse import urlparse

import httpx
import psycopg
from jsonschema import Draft202012Validator, FormatChecker
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from .github_issues import CollectionError, rate_retry_at, repository_parts

SCHEMA = json.loads((Path(__file__).resolve().parents[3] /
                     "packages/contracts/sync-github-discussions-job.v1.schema.json").read_text(encoding="utf-8"))
VALIDATOR = Draft202012Validator(SCHEMA, format_checker=FormatChecker())
GRAPHQL_URL = "https://api.github.com/graphql"
QUERY = """query MarketRiftDiscussions($owner: String!, $repo: String!, $first: Int!, $after: String) {
  repository(owner: $owner, name: $repo) {
    isPrivate
    hasDiscussionsEnabled
    discussions(first: $first, after: $after, orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes { id number title body createdAt updatedAt url closed category { name } author { login } }
      pageInfo { endCursor hasNextPage }
    }
  }
}"""


class Category(BaseModel):
    name: str = Field(min_length=1, max_length=200)


class Author(BaseModel):
    login: str = Field(min_length=1, max_length=100)


class Discussion(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str = Field(min_length=1, max_length=200)
    number: int = Field(gt=0)
    title: str = Field(min_length=1, max_length=1000)
    body: str = Field(max_length=100000)
    createdAt: datetime
    updatedAt: datetime
    url: str
    closed: bool
    category: Category
    author: Author | None = None


def validate_job(payload: object) -> dict:
    VALIDATOR.validate(payload)
    assert isinstance(payload, dict)
    if payload["idempotency_key"] != f"github-discussions-{payload['run_id']}-v1":
        raise CollectionError("invalid_job_key")
    return payload


def endpoint() -> str:
    test_url = os.getenv("GITHUB_DISCUSSIONS_TEST_BASE_URL")
    if test_url and os.getenv("MARKETRIFT_TEST_MODE") == "1":
        parsed = urlparse(test_url)
        if parsed.scheme == "http" and parsed.hostname in ("127.0.0.1", "localhost") and not parsed.username:
            return test_url.rstrip("/") + "/graphql"
    return GRAPHQL_URL


def graphql_error_code(messages: list[str]) -> str:
    """Map remote messages to stable, non-sensitive codes; never persist response text."""
    combined = " ".join(messages).casefold()
    if "rate limit" in combined or "abuse" in combined:
        return "rate_limited"
    if "bad credentials" in combined or "requires authentication" in combined:
        return "github_unauthorized"
    if ("resource not accessible" in combined or "insufficient scope" in combined or
            "permission" in combined):
        return "github_permission_denied"
    if "forbidden" in combined:
        return "github_forbidden"
    if ("doesn't exist on type" in combined or "cannot query field" in combined or
            "variable" in combined and "invalid" in combined):
        return "graphql_query_invalid"
    return "graphql_error"


async def fetch_discussions(repository_url: str, cursor: str | None, max_pages: int,
                            max_items: int, client: httpx.AsyncClient, token: str
                            ) -> tuple[list[Discussion], int, str | None, bool]:
    owner, repo = repository_parts(repository_url)
    if not token:
        raise CollectionError("configuration_pending")
    if max_pages not in range(1, 4) or max_items not in range(1, 51):
        raise CollectionError("invalid_limits")
    seen: list[Discussion] = []
    pages = 0
    after = cursor
    complete = False
    for _ in range(max_pages):
        variables = {"owner": owner, "repo": repo, "first": min(20, max_items - len(seen)), "after": after}
        for attempt in range(3):
            try:
                response = await client.post(endpoint(), json={"query": QUERY, "variables": variables},
                                             headers={"Authorization": f"Bearer {token}",
                                                      "Accept": "application/vnd.github+json",
                                                      "User-Agent": "MarketRift-public-discussions-connector"})
            except (httpx.TimeoutException, httpx.NetworkError) as error:
                if attempt == 2:
                    raise CollectionError("network_failure") from error
                await asyncio.sleep(0.5 * 2**attempt)
                continue
            response_hint = ""
            if response.status_code == 403:
                try:
                    body = response.json()
                    response_hint = str(body.get("message", "")).lower() if isinstance(body, dict) else ""
                except ValueError:
                    pass
            if response.status_code in (429, 403) and (response.status_code == 429 or
                    response.headers.get("retry-after") or response.headers.get("x-ratelimit-remaining") == "0" or
                    "rate limit" in response_hint or "abuse" in response_hint):
                raise CollectionError("rate_limited", rate_retry_at(response))
            if response.status_code == 401:
                raise CollectionError("github_unauthorized")
            if response.status_code == 403:
                code = graphql_error_code([response_hint])
                raise CollectionError(code if code == "github_permission_denied" else "github_forbidden")
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
            if not isinstance(payload, dict):
                raise TypeError("invalid envelope")
            errors = payload.get("errors") or []
            if errors:
                messages = [str(item.get("message", "")) for item in errors if isinstance(item, dict)]
                code = graphql_error_code(messages)
                if response.headers.get("x-ratelimit-remaining") == "0" or code == "rate_limited":
                    raise CollectionError("rate_limited", rate_retry_at(response))
                raise CollectionError(code)
            repository = payload["data"]["repository"]
            if repository is None or repository["isPrivate"]:
                raise CollectionError("repository_unavailable_or_private")
            if not repository["hasDiscussionsEnabled"]:
                raise CollectionError("discussions_disabled")
            connection = repository["discussions"]
            nodes = connection["nodes"]
            page_info = connection["pageInfo"]
            if (not isinstance(nodes, list) or len(nodes) > variables["first"] or
                    not isinstance(page_info["hasNextPage"], bool)):
                raise TypeError("invalid connection")
            for item in nodes:
                discussion = Discussion.model_validate(item)
                expected = f"https://github.com/{owner}/{repo}/discussions/{discussion.number}"
                if discussion.url.lower() != expected.lower():
                    raise ValueError("invalid discussion URL")
                seen.append(discussion)
            next_cursor = page_info["endCursor"]
            complete = not page_info["hasNextPage"]
            if not complete and (not isinstance(next_cursor, str) or next_cursor == after):
                raise ValueError("invalid cursor")
            after = next_cursor
        except CollectionError:
            raise
        except (KeyError, TypeError, ValueError, ValidationError) as error:
            raise CollectionError("invalid_graphql_payload") from error
        if not complete and len(seen) < max_items and response.headers.get("x-ratelimit-remaining") == "0":
            raise CollectionError("rate_limited", rate_retry_at(response))
        if complete or len(seen) >= max_items:
            break
    return seen, pages, after, complete


async def _fail(job: dict, error: CollectionError) -> None:
    async with await psycopg.AsyncConnection.connect(os.environ["RUNTIME_DATABASE_URL"]) as connection:
        await connection.execute("SELECT set_config('app.tenant_id', %s, true)", (job["tenant_id"],))
        await connection.execute(
            "UPDATE marketrift.source_runs SET status = 'failed', error_code = %s, retry_after_at = %s, "
            "finished_at = now() WHERE tenant_id = %s AND id = %s AND source_id = %s AND status = 'running'",
            (error.code, error.retry_at, job["tenant_id"], job["run_id"], job["source_id"]),
        )


async def sync_github_discussions(payload: object, client: httpx.AsyncClient | None = None) -> dict:
    job = validate_job(payload)
    async with await psycopg.AsyncConnection.connect(os.environ["RUNTIME_DATABASE_URL"]) as connection:
        await connection.execute("SELECT set_config('app.tenant_id', %s, true)", (job["tenant_id"],))
        source = await (await connection.execute(
            "SELECT s.url FROM marketrift.sources s JOIN marketrift.products p "
            "ON p.tenant_id = s.tenant_id AND p.id = s.product_id "
            "WHERE s.tenant_id = %s AND s.id = %s AND s.source_type = 'github_discussions' AND s.enabled",
            (job["tenant_id"], job["source_id"]),
        )).fetchone()
        run = await (await connection.execute(
            "SELECT status, cursor_before, max_pages, max_items FROM marketrift.source_runs "
            "WHERE tenant_id = %s AND id = %s AND source_id = %s FOR UPDATE",
            (job["tenant_id"], job["run_id"], job["source_id"]),
        )).fetchone()
        if source is None or run is None or run[2] is None:
            raise CollectionError("source_or_run_not_in_tenant")
        if run[0] != "pending":
            return {"status": run[0], "replayed": True}
        await connection.execute("UPDATE marketrift.source_runs SET status = 'running', started_at = now() WHERE id = %s",
                                 (job["run_id"],))
    owned_client = client is None
    if owned_client:
        client = httpx.AsyncClient(timeout=10, follow_redirects=False)
    assert client is not None
    try:
        discussions, pages, cursor_after, complete = await fetch_discussions(
            source[0], run[1], run[2], run[3], client, os.getenv("GITHUB_DISCUSSIONS_TOKEN", ""))
        owner, repo = repository_parts(source[0])
        repository = f"{owner}/{repo}"
        new_count = updated_count = 0
        async with await psycopg.AsyncConnection.connect(os.environ["RUNTIME_DATABASE_URL"]) as connection:
            await connection.execute("SELECT set_config('app.tenant_id', %s, true)", (job["tenant_id"],))
            locked = await (await connection.execute(
                "SELECT r.status FROM marketrift.source_runs r JOIN marketrift.sources s "
                "ON s.tenant_id = r.tenant_id AND s.id = r.source_id "
                "JOIN marketrift.products p ON p.tenant_id = s.tenant_id AND p.id = s.product_id "
                "WHERE r.tenant_id = %s AND r.id = %s AND r.source_id = %s "
                "AND s.source_type = 'github_discussions' AND s.enabled AND s.url = %s FOR UPDATE OF r",
                (job["tenant_id"], job["run_id"], job["source_id"], source[0]),
            )).fetchone()
            if locked is None or locked[0] != "running":
                raise CollectionError("run_state_changed")
            for discussion in discussions:
                title = discussion.title
                original_body = discussion.body
                display_body = title + ("\n\n" + original_body if original_body else "")
                category = discussion.category.name
                content_status = "available" if len(original_body.strip()) >= 20 else "insufficient"
                relevance = "announcement" if re.sub(r"\s+", " ", category.strip()).casefold() == "announcements" else "not_assessed"
                fields = (discussion.url, title, original_body, discussion.updatedAt,
                          "closed" if discussion.closed else "open", category,
                          discussion.author.login if discussion.author else None, content_status, relevance)
                existing = await (await connection.execute(
                    "SELECT source_url, source_title, source_body, source_updated_at, source_state, "
                    "discussion_category, discussion_author, discussion_content_status, discussion_relevance "
                    "FROM marketrift.documents WHERE tenant_id = %s AND source_id = %s AND external_key = %s",
                    (job["tenant_id"], job["source_id"], discussion.id),
                )).fetchone()
                if existing is None:
                    inserted = await connection.execute(
                        "INSERT INTO marketrift.documents (tenant_id, source_id, document_type, external_key, "
                        "source_url, body, published_at, source_title, source_body, source_created_at, "
                        "source_updated_at, source_state, source_repository, discussion_category, discussion_author, "
                        "discussion_content_status, discussion_relevance, synthetic) "
                        "VALUES (%s, %s, 'github_discussion', %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, false) "
                        "ON CONFLICT (tenant_id, source_id, external_key) DO NOTHING",
                        (job["tenant_id"], job["source_id"], discussion.id, discussion.url, display_body,
                         discussion.createdAt, title, original_body, discussion.createdAt, discussion.updatedAt,
                         fields[4], repository, category, fields[6], content_status, relevance),
                    )
                    new_count += inserted.rowcount
                elif discussion.updatedAt >= existing[3] and fields != existing:
                    await connection.execute(
                        "UPDATE marketrift.documents SET source_url = %s, body = %s, source_title = %s, "
                        "source_body = %s, source_updated_at = %s, source_state = %s, "
                        "discussion_category = %s, discussion_author = %s, discussion_content_status = %s, "
                        "discussion_relevance = %s, collected_at = now() "
                        "WHERE tenant_id = %s AND source_id = %s AND external_key = %s",
                        (discussion.url, display_body, title, original_body, discussion.updatedAt, fields[4],
                         category, fields[6], content_status, relevance, job["tenant_id"], job["source_id"], discussion.id),
                    )
                    updated_count += 1
            await connection.execute(
                "UPDATE marketrift.source_runs SET status = 'succeeded', cursor_after = %s, scan_complete = %s, "
                "documents_seen = %s, documents_new = %s, documents_updated = %s, pages_fetched = %s, "
                "finished_at = now() WHERE id = %s",
                (cursor_after, complete, len(discussions), new_count, updated_count, pages, job["run_id"]),
            )
            await connection.execute("UPDATE marketrift.sources SET last_checked_at = now() WHERE tenant_id = %s AND id = %s",
                                     (job["tenant_id"], job["source_id"]))
        return {"status": "succeeded", "seen": len(discussions), "new": new_count,
                "updated": updated_count, "scan_complete": complete}
    except CollectionError as error:
        await _fail(job, error)
        return {"status": "failed", "error_code": error.code}
    except Exception:
        await _fail(job, CollectionError("internal_failure"))
        raise
    finally:
        if owned_client:
            await client.aclose()
