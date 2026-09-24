"""Deterministic Steam HTTP, parsing, pagination and limit tests."""

import asyncio
import os
from datetime import UTC, datetime

import httpx
import pytest

from marketrift_intelligence.steam_reviews import (
    SteamCollectionError,
    app_id_from_source,
    endpoint,
    fetch_reviews,
)


def run(coro):
    if os.name == "nt":
        return asyncio.run(coro, loop_factory=asyncio.SelectorEventLoop)
    return asyncio.run(coro)


def review(identifier="11", updated=1780000000, body="The controls are easy to use.", voted_up=True):
    return {"recommendationid": identifier, "review": body, "language": "english",
            "timestamp_created": 1779000000, "timestamp_updated": updated, "voted_up": voted_up,
            "author": {"steamid": "must-never-be-stored", "playtime_forever": 800}}


def test_recent_cursor_pagination_and_minimal_fields():
    calls = []

    def respond(request):
        calls.append(request)
        assert request.url.host == "store.steampowered.com"
        if request.url.params["cursor"] == "*":
            return httpx.Response(200, json={"success": 1, "cursor": "next+page", "reviews": [review()]})
        return httpx.Response(200, json={"success": 1, "cursor": "done", "reviews": [review("12", body="Too slow", voted_up=False)]})

    async def collect():
        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
            return await fetch_reviews(620, None, 2, 2, client)

    rows, received, pages, ignored, complete, cursor = run(collect())
    assert ([row.recommendationid for row in rows], received, pages, ignored, complete) == (
        ["11", "12"], 2, 2, 0, False)
    assert cursor is not None
    assert calls[0].url.params["filter"] == "recent"
    assert calls[1].url.params["cursor"] == "next+page"
    assert "steamid" not in rows[0].model_dump()


def test_incremental_overlap_and_ignored_old_or_duplicate():
    old = int(datetime(2026, 5, 1, tzinfo=UTC).timestamp())
    now = int(datetime(2026, 5, 3, tzinfo=UTC).timestamp())
    calls = []

    def respond(request):
        calls.append(request)
        return httpx.Response(200, json={"success": 1, "cursor": "later", "reviews": [
            review("11", now), review("11", now), review("10", old)]})

    async def collect():
        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
            return await fetch_reviews(620, datetime.fromtimestamp(now, UTC).isoformat(), 1, 5, client)

    rows, received, pages, ignored, complete, _ = run(collect())
    assert ([row.recommendationid for row in rows], received, pages, ignored, complete) == (
        ["11"], 3, 1, 2, False)
    assert calls[0].url.params["filter"] == "updated"


@pytest.mark.parametrize("status,body,headers,code", [
    (404, {}, {}, "product_not_found"),
    (403, {}, {}, "forbidden"),
    (429, {}, {"Retry-After": "3"}, "rate_limited"),
    (500, {}, {}, "upstream_failure"),
    (200, {"success": 0, "cursor": "", "reviews": []}, {}, "product_unavailable_or_invalid"),
    (200, {"success": 1, "cursor": "x", "reviews": [review(body="x", voted_up="false")]}, {},
     "invalid_response"),
])
def test_http_and_malformed_payload(status, body, headers, code):
    calls = []

    def respond(request):
        calls.append(request)
        return httpx.Response(status, json=body, headers=headers)

    async def collect():
        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
            return await fetch_reviews(620, None, 1, 2, client)

    with pytest.raises(SteamCollectionError) as caught:
        run(collect())
    assert caught.value.code == code
    assert len(calls) == (3 if status == 500 else 1)
    if code == "rate_limited":
        assert caught.value.retry_at > datetime.now(UTC)


def test_timeout_retry_is_bounded():
    calls = []

    def timeout(request):
        calls.append(request)
        raise httpx.ReadTimeout("temporary timeout", request=request)

    async def collect():
        async with httpx.AsyncClient(transport=httpx.MockTransport(timeout)) as client:
            return await fetch_reviews(620, None, 1, 1, client)

    with pytest.raises(SteamCollectionError, match="network_failure"):
        run(collect())
    assert len(calls) == 3


def test_small_negative_only_sampling_uses_official_filter():
    calls = []

    def respond(request):
        calls.append(request)
        return httpx.Response(200, json={"success": 1, "cursor": "next",
                                         "reviews": [review("77", voted_up=False)]})

    async def collect():
        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
            return await fetch_reviews(620, None, 1, 20, client, review_type="negative")

    rows, received, pages, _, _, _ = run(collect())
    assert (len(rows), received, pages) == (1, 1, 1)
    assert calls[0].url.host == "store.steampowered.com"
    assert calls[0].url.params["review_type"] == "negative"
    assert calls[0].url.params["num_per_page"] == "20"


def test_invalid_source_and_test_endpoint_guard(monkeypatch):
    assert app_id_from_source("https://store.steampowered.com/app/620/") == 620
    for value in ("https://evil.test/app/620/", "https://store.steampowered.com/appreviews/620",
                  "https://store.steampowered.com/app/0/"):
        with pytest.raises(SteamCollectionError):
            app_id_from_source(value)
    monkeypatch.setenv("STEAM_REVIEW_TEST_BASE_URL", "http://127.0.0.1:9999")
    monkeypatch.delenv("MARKETRIFT_TEST_MODE", raising=False)
    assert endpoint(620) == "https://store.steampowered.com/appreviews/620"
    monkeypatch.setenv("MARKETRIFT_TEST_MODE", "1")
    assert endpoint(620) == "http://127.0.0.1:9999/appreviews/620"
    monkeypatch.setenv("STEAM_REVIEW_TEST_BASE_URL", "http://evil.test:9999")
    with pytest.raises(SteamCollectionError):
        endpoint(620)
    monkeypatch.setenv("STEAM_REVIEW_TEST_BASE_URL", "http://user@127.0.0.1:9999")
    with pytest.raises(SteamCollectionError):
        endpoint(620)
