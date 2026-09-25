import asyncio
from datetime import UTC, datetime, timedelta

import httpx
import pytest

from marketrift_intelligence.g2_reviews import G2Error, check_access, endpoint, fetch_reviews, review_text, review_url


def row(review_id: str, *, public: bool = True, body: str = "The invoice export failed.") -> dict:
    return {"id": review_id, "type": "survey_responses", "attributes": {
        "is_public": public, "title": "Test review",
        "url": f"https://www.g2.com/products/example/reviews/review-{review_id}",
        "answers": {"hate": {"value": body}}, "published_at": "2026-09-01T12:00:00Z",
        "user_updated_at": "2026-09-02T12:00:00Z", "star_rating": 3.0,
        "user": {"name": "Do not store this unnecessary identity"},
    }}


def test_pagination_and_minimal_text(monkeypatch):
    monkeypatch.setenv("MARKETRIFT_TEST_MODE", "1")
    monkeypatch.setenv("G2_TEST_BASE_URL", "http://127.0.0.1:3127")
    requested = []

    def handler(request):
        requested.append((request.url.path, request.url.params["page[number]"]))
        page = int(request.url.params["page[number]"])
        return httpx.Response(200, json={"data": [row(str(page))],
                                           "links": {"next": "https://data.g2.com/unsafe?api_token=secret" if page == 1 else None}})

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            reviews, received, pages, complete, cursor = await fetch_reviews("product-1", 1, 2, 2, "test-token", "sandbox", client)
        assert (received, pages, complete, cursor) == (2, 2, True, None)
        assert [r.id for r in reviews] == ["1", "2"]
        assert review_text(reviews[0]) == "The invoice export failed."
        assert review_url(reviews[0]).startswith("https://www.g2.com/")
        assert requested == [("/api/2018-01-01/syndication/reviews", "1"),
                             ("/api/2018-01-01/syndication/reviews", "2")]
    asyncio.run(run())


def test_documented_page_count_can_drive_pagination_without_links(monkeypatch):
    monkeypatch.setenv("MARKETRIFT_TEST_MODE", "1")
    monkeypatch.setenv("G2_TEST_BASE_URL", "http://127.0.0.1:3127")

    def handler(request):
        page = int(request.url.params["page[number]"])
        return httpx.Response(200, json={"data": [row(str(page))], "meta": {"page_count": 2}})

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            reviews, received, pages, complete, cursor = await fetch_reviews(
                "product-1", 1, 2, 2, "test-token", "sandbox", client)
        assert [r.id for r in reviews] == ["1", "2"]
        assert (received, pages, complete, cursor) == (2, 2, True, None)
    asyncio.run(run())


def test_missing_pagination_proof_fails_instead_of_claiming_complete(monkeypatch):
    monkeypatch.setenv("MARKETRIFT_TEST_MODE", "1")
    monkeypatch.setenv("G2_TEST_BASE_URL", "http://127.0.0.1:3127")

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(
                lambda _: httpx.Response(200, json={"data": [row("1")]}))) as client:
            with pytest.raises(G2Error, match="pagination_unconfirmed"):
                await fetch_reviews("product-1", 1, 1, 1, "test-token", "sandbox", client)
    asyncio.run(run())


@pytest.mark.parametrize("status,code", [(401, "credential_invalid"), (403, "scope_or_product_access_denied"),
                                          (404, "product_not_found"), (429, "rate_limited")])
def test_http_failures_are_classified_without_response_text(monkeypatch, status, code):
    monkeypatch.setenv("MARKETRIFT_TEST_MODE", "1")
    monkeypatch.setenv("G2_TEST_BASE_URL", "http://127.0.0.1:3127")

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(
                lambda _: httpx.Response(status, text="secret response",
                                         headers={"Retry-After": "2"} if status == 429 else {}))) as client:
            with pytest.raises(G2Error) as exc:
                await fetch_reviews("product-1", 1, 1, 5, "secret-token", "sandbox", client)
        assert exc.value.code == code
        assert "secret" not in str(exc.value)
    asyncio.run(run())


def test_sandbox_never_uses_unconfirmed_live_endpoint(monkeypatch):
    monkeypatch.delenv("MARKETRIFT_TEST_MODE", raising=False)
    monkeypatch.delenv("G2_TEST_BASE_URL", raising=False)
    with pytest.raises(G2Error, match="sandbox_endpoint_unconfirmed"):
        endpoint("sandbox")
    assert endpoint("production") == "https://data.g2.com/api/2018-01-01/syndication/reviews"


def test_absent_credential_and_unconfirmed_rights_block_live_calls(monkeypatch):
    future = datetime.now(UTC) + timedelta(days=1)
    with pytest.raises(G2Error, match="credential_missing"):
        check_access("production", None, True, "written agreement", future, False)
    monkeypatch.delenv("G2_PRODUCTION_ENABLED", raising=False)
    with pytest.raises(G2Error, match="rights_unconfirmed"):
        check_access("production", "test-token", True, "written agreement", future, False)
    monkeypatch.setenv("G2_PRODUCTION_ENABLED", "1")
    with pytest.raises(G2Error, match="rights_unconfirmed"):
        check_access("production", "test-token", False, None, None, False)
    check_access("production", "test-token", True, "written agreement", future, False)


def test_bad_review_url_is_rejected():
    from marketrift_intelligence.g2_reviews import G2Review
    value = G2Review.model_validate_json(httpx.Response(200, json=row("1")).content)
    value.attributes.url = "https://not-g2.example/reviews/1"
    with pytest.raises(G2Error, match="review_url_invalid"):
        review_url(value)


def test_transient_503_retries_within_small_limit(monkeypatch):
    monkeypatch.setenv("MARKETRIFT_TEST_MODE", "1")
    monkeypatch.setenv("G2_TEST_BASE_URL", "http://127.0.0.1:3127")
    original_sleep = asyncio.sleep
    monkeypatch.setattr("marketrift_intelligence.g2_reviews.asyncio.sleep", lambda _: original_sleep(0))
    attempts = 0

    def handler(_):
        nonlocal attempts
        attempts += 1
        return httpx.Response(503) if attempts < 3 else httpx.Response(200, json={"data": [row("1")], "links": {"next": None}})

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            result = await fetch_reviews("product-1", 1, 1, 1, "test-token", "sandbox", client)
        assert result[1:4] == (1, 1, True)
        assert attempts == 3
    asyncio.run(run())
