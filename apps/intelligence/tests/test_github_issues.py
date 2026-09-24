"""No network or model calls; HTTP responses are deterministic fixtures."""

import asyncio
from datetime import UTC, datetime, timedelta

import httpx
import pytest

from marketrift_intelligence.github_issues import (
    CollectionError,
    fetch_issues,
    rate_retry_at,
    repository_parts,
)


def run(coro):
    if __import__("os").name == "nt":
        return asyncio.run(coro, loop_factory=asyncio.SelectorEventLoop)
    return asyncio.run(coro)


def issue(issue_id: int, updated: str = "2026-09-24T12:00:00Z", body: str = "Bug") -> dict:
    return {"id": issue_id, "number": issue_id, "html_url": f"https://github.com/example/repo/issues/{issue_id}",
            "title": f"Issue {issue_id}", "body": body, "created_at": "2026-09-01T12:00:00Z",
            "updated_at": updated, "state": "open"}


def test_pagination_skips_pull_requests_and_bounds_items():
    requests = []

    def respond(request):
        requests.append(request)
        assert request.url.host == "api.github.com"
        assert request.headers["X-GitHub-Api-Version"] == "2022-11-28"
        page = request.url.params["page"]
        if page == "1":
            pr = {**issue(2), "pull_request": {"url": "https://api.github.com/pr"}}
            return httpx.Response(200, json=[pr, issue(1)], headers={"Link":
                '<https://api.github.com/repos/example/repo/issues?page=2>; rel="next"'})
        return httpx.Response(200, json=[issue(3)])

    async def collect():
        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
            return await fetch_issues("https://github.com/example/repo", None, 2, 2, client)

    found, pages, skipped, cursor = run(collect())
    assert [item.id for item in found] == [1, 3]
    assert (pages, skipped) == (2, 1)
    assert cursor is not None
    assert len(requests) == 2
    assert all(request.url.params["per_page"] == "2" for request in requests)


def test_incremental_since_and_untrusted_link_rejected():
    seen = []

    def respond(request):
        seen.append(request)
        return httpx.Response(200, json=[issue(1)], headers={"Link":
            '<https://evil.test/steal?page=2>; rel="next"'})

    async def collect():
        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
            return await fetch_issues("https://github.com/example/repo", "2026-09-24T12:00:00Z", 2, 5, client)

    with pytest.raises(CollectionError, match="invalid_pagination_link"):
        run(collect())
    assert seen[0].url.params["direction"] == "asc"
    assert seen[0].url.params["since"] == "2026-09-24T11:59:00Z"
    assert len(seen) == 1


@pytest.mark.parametrize("status,headers,message,code", [
    (404, {}, "", "repository_not_found"),
    (403, {}, "", "forbidden"),
    (403, {"x-ratelimit-remaining": "0", "x-ratelimit-reset": "1890000000"}, "", "rate_limited"),
    (403, {}, "secondary rate limit", "rate_limited"),
    (429, {"Retry-After": "5"}, "", "rate_limited"),
    (500, {}, "", "upstream_failure"),
])
def test_failures_and_rate_limits(status, headers, message, code):
    calls = []

    def respond(request):
        calls.append(request)
        return httpx.Response(status, headers=headers, json={"message": message})

    async def collect():
        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
            return await fetch_issues("https://github.com/example/repo", None, 1, 1, client)

    with pytest.raises(CollectionError) as caught:
        run(collect())
    assert caught.value.code == code
    assert len(calls) == (3 if status == 500 else 1)
    if code == "rate_limited":
        assert caught.value.retry_at > datetime.now(UTC)


def test_retry_after_and_invalid_repository():
    response = httpx.Response(429, headers={"Retry-After": "10"})
    assert rate_retry_at(response) >= datetime.now(UTC) + timedelta(seconds=9)
    for value in ("https://evil.test/example/repo", "https://github.com/example/repo/issues",
                  "https://github.com/example/repo?x=1"):
        with pytest.raises(CollectionError):
            repository_parts(value)


def test_invalid_issue_origin_does_not_become_document():
    def respond(_request):
        return httpx.Response(200, json=[{**issue(1), "html_url": "https://evil.test/fake"}])

    async def collect():
        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
            return await fetch_issues("https://github.com/example/repo", None, 1, 1, client)

    with pytest.raises(CollectionError, match="invalid_issue_payload"):
        run(collect())
