"""Deterministic GraphQL behavior; no GitHub or OpenAI requests."""

import asyncio

import httpx
import pytest

from marketrift_intelligence.github_discussions import QUERY, CollectionError, endpoint, fetch_discussions


def run(coro):
    return asyncio.run(coro, loop_factory=asyncio.SelectorEventLoop) if __import__("os").name == "nt" else asyncio.run(coro)


def discussion(number=1, body="A concrete product feedback message.", updated="2026-09-24T12:00:00Z"):
    return {"id": f"D_{number}", "number": number, "title": "Feedback", "body": body,
            "createdAt": "2026-09-01T10:00:00Z", "updatedAt": updated,
            "url": f"https://github.com/example/repo/discussions/{number}", "closed": False,
            "category": {"name": "Ideas"}, "author": {"login": "public-user"}}


def envelope(nodes, next_page=False, cursor="cursor-one", *, private=False, enabled=True):
    return {"data": {"repository": {"isPrivate": private, "hasDiscussionsEnabled": enabled,
            "discussions": {"nodes": nodes, "pageInfo": {"endCursor": cursor, "hasNextPage": next_page}}}}}


def invoke(handler, *, cursor=None, pages=2, items=5, token="test-only"):
    async def work():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            return await fetch_discussions("https://github.com/example/repo", cursor, pages, items, client, token)
    return run(work())


def test_pagination_and_bounds():
    assert "closed category" in QUERY
    assert "isClosed" not in QUERY
    calls = []

    def handler(request):
        assert request.url == "https://api.github.com/graphql"
        assert request.headers["authorization"] == "Bearer test-only"
        variables = __import__("json").loads(request.content)["variables"]
        calls.append(variables)
        return httpx.Response(200, json=envelope([discussion(len(calls))], len(calls) == 1,
                                                f"cursor-{len(calls)}"))

    rows, pages, cursor, complete = invoke(handler)
    assert [row.id for row in rows] == ["D_1", "D_2"]
    assert (pages, cursor, complete) == (2, "cursor-2", True)
    assert [item["after"] for item in calls] == [None, "cursor-1"]
    calls.clear()
    assert invoke(handler, pages=1, items=1)[3] is False


def test_missing_token_private_disabled_and_invalid_provenance():
    no_request = lambda _request: pytest.fail("Unexpected network call")
    with pytest.raises(CollectionError, match="configuration_pending"):
        invoke(no_request, token="")
    for payload, expected in ((envelope([], private=True), "repository_unavailable_or_private"),
                              (envelope([], enabled=False), "discussions_disabled"),
                              (envelope([{**discussion(), "url": "https://evil.invalid/1"}]), "invalid_graphql_payload")):
        with pytest.raises(CollectionError, match=expected):
            invoke(lambda _request, value=payload: httpx.Response(200, json=value))


def test_rate_limit_and_transient_failure():
    with pytest.raises(CollectionError, match="rate_limited") as caught:
        invoke(lambda _request: httpx.Response(200, headers={"x-ratelimit-remaining": "0", "retry-after": "2"},
                                              json={"errors": [{"message": "API rate limit exceeded"}]}))
    assert caught.value.retry_at is not None
    with pytest.raises(CollectionError, match="rate_limited"):
        invoke(lambda _request: httpx.Response(200, headers={"x-ratelimit-remaining": "0"},
                                              json=envelope([discussion()], next_page=True)))
    with pytest.raises(CollectionError, match="rate_limited"):
        invoke(lambda _request: httpx.Response(403, json={"message": "secondary rate limit"}))
    count = 0

    def flaky(_request):
        nonlocal count
        count += 1
        return httpx.Response(503) if count < 3 else httpx.Response(200, json=envelope([discussion()]))

    assert invoke(flaky)[0][0].id == "D_1"
    assert count == 3
    with pytest.raises(CollectionError, match="upstream_failure"):
        invoke(lambda _request: httpx.Response(503))


def test_graphql_error_is_not_partial_success():
    with pytest.raises(CollectionError, match="graphql_error"):
        invoke(lambda _request: httpx.Response(200, json={"data": {"repository": None},
                                                      "errors": [{"message": "resource denied"}]}))


@pytest.mark.parametrize(("status", "message", "expected"), [
    (401, "Bad credentials", "github_unauthorized"),
    (403, "Forbidden", "github_forbidden"),
    (403, "Resource not accessible by personal access token", "github_permission_denied"),
    (200, "Field 'isClosed' doesn't exist on type 'Discussion'", "graphql_query_invalid"),
    (200, "Resource not accessible by personal access token", "github_permission_denied"),
])
def test_auth_permission_and_query_errors_are_distinct(status, message, expected):
    with pytest.raises(CollectionError, match=expected):
        invoke(lambda _request: httpx.Response(status, json={"errors": [{"message": message}],
                                                       "message": message}))


def test_graphql_endpoint_is_fixed_outside_local_e2e(monkeypatch):
    monkeypatch.setenv("GITHUB_DISCUSSIONS_TEST_BASE_URL", "http://127.0.0.1:9999")
    monkeypatch.delenv("MARKETRIFT_TEST_MODE", raising=False)
    assert endpoint() == "https://api.github.com/graphql"
    monkeypatch.setenv("MARKETRIFT_TEST_MODE", "1")
    assert endpoint() == "http://127.0.0.1:9999/graphql"
    monkeypatch.setenv("GITHUB_DISCUSSIONS_TEST_BASE_URL", "http://internal.example:9999")
    assert endpoint() == "https://api.github.com/graphql"
