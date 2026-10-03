"""Deterministic page fetching, SSRF, extraction and comparison tests."""

import http.client
import socket

import pytest

from marketrift_intelligence.web_pages import (
    PageError,
    canonical_url,
    compare_pages,
    e2e_fetch_public_page,
    fetch_public_page,
    page_content,
    public_content_hash,
    reparse_markup,
    request_pinned_capture,
    resolve_public,
    semantic_hash,
)


def dns(address):
    return lambda _host, _port, **_kwargs: [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (address, 443))]


@pytest.mark.parametrize("url", [
    "http://example.com/pricing", "https://127.0.0.1/pricing", "https://localhost/pricing",
    "https://169.254.169.254/latest/meta-data", "https://user:pass@example.com/",
    "https://example.com:8443/pricing", "https://example.com/pricing?token=secret",
    "https://service.internal/pricing", "https://example.com./pricing",
])
def test_unsafe_url_rejected_before_network(url):
    with pytest.raises(PageError):
        canonical_url(url)


@pytest.mark.parametrize("address", ["127.0.0.1", "10.1.2.3", "169.254.169.254",
                                      "172.16.0.2", "192.168.1.2", "::1", "fe80::1"])
def test_private_dns_result_is_rejected(address):
    with pytest.raises(PageError, match="unsafe_destination"):
        resolve_public("example.com", dns(address))


def test_mixed_public_and_private_dns_is_rejected():
    def lookup(_host, _port, **_kwargs):
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.215.14", 443)),
                (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("169.254.169.254", 443))]

    with pytest.raises(PageError, match="unsafe_destination"):
        resolve_public("example.com", lookup)


def test_local_e2e_transport_is_disabled_without_test_mode(monkeypatch):
    monkeypatch.delenv("MARKETRIFT_TEST_MODE", raising=False)
    monkeypatch.setenv("WEB_PAGE_TEST_BASE_URL", "http://127.0.0.1:9876")
    with pytest.raises(PageError, match="test_transport_disabled"):
        e2e_fetch_public_page("https://example.com/pricing")


def test_local_e2e_transport_rejects_real_page_host(monkeypatch):
    monkeypatch.setenv("MARKETRIFT_TEST_MODE", "1")
    monkeypatch.setenv("WEB_PAGE_TEST_BASE_URL", "http://127.0.0.1:9876")
    with pytest.raises(PageError, match="invalid_test_host"):
        e2e_fetch_public_page("https://www.postgresql.org/docs/release/")


def test_redirect_to_internal_or_other_host_never_gets_requested():
    calls = []

    def responder(url, ip):
        calls.append((url, ip))
        if url.endswith("robots.txt"):
            return 404, {}, b""
        return 302, {"location": "https://169.254.169.254/latest/meta-data"}, b""

    with pytest.raises(PageError, match="unsafe_destination"):
        fetch_public_page("https://example.com/pricing", lookup=dns("93.184.215.14"), request=responder)
    assert len(calls) == 2
    assert all(host == "93.184.215.14" for _, host in calls)


def test_same_host_redirect_and_robots_are_checked():
    calls = []

    def responder(url, _ip):
        calls.append(url)
        if url.endswith("robots.txt"):
            return 200, {}, b"User-agent: *\nAllow: /\n"
        if url.endswith("/old"):
            return 301, {"location": "/new"}, b""
        return 200, {"content-type": "text/html"}, b"<main><p>Public release text.</p></main>"

    final, html = fetch_public_page("https://example.com/old", lookup=dns("93.184.215.14"), request=responder)
    assert final == "https://example.com/new"
    assert "Public release" in html
    assert len(calls) == 3


@pytest.mark.parametrize("status,headers,code", [
    (403, {}, "access_denied"), (404, {}, "not_found"),
    (429, {"retry-after": "30"}, "rate_limited"),
    (500, {}, "http_failure"),
])
def test_http_failures_do_not_make_up_a_snapshot(status, headers, code):
    def responder(url, _ip):
        if url.endswith("robots.txt"):
            return 404, {}, b""
        return status, headers, b""

    with pytest.raises(PageError, match=code) as caught:
        fetch_public_page("https://example.com/pricing", lookup=dns("93.184.215.14"), request=responder)
    if status == 429:
        assert caught.value.retry_at is not None


def test_robots_disallow_and_no_visible_content():
    calls = []

    def responder(url, _ip):
        calls.append(url)
        return 200, {}, b"User-agent: *\nDisallow: /pricing\n"

    with pytest.raises(PageError, match="robots_disallowed"):
        fetch_public_page("https://example.com/pricing", lookup=dns("93.184.215.14"), request=responder)
    assert calls == ["https://example.com/robots.txt"]
    with pytest.raises(PageError, match="no_extractable_content"):
        page_content("<main><script>secret</script><footer>2026</footer></main>",
                     "pricing_page", "https://example.com/pricing")


def test_individual_public_page_is_observation_only_and_literal():
    html = ('<html><head><title>Public article</title></head><body><main>'
            '<h1>Public article</h1><time datetime="2026-10-02">2 October 2026</time>'
            '<p>A product article with a specific public statement.</p></main></body></html>')
    observed = page_content(html, "public_page", "https://example.com/blog/article")
    assert observed["title"] == "Public article"
    assert observed["origin_date_literal"] == "2 October 2026"
    assert observed["origin_date_evidence"] == {"element": "time", "text": "2 October 2026",
                                                "datetime_attribute": "2026-10-02"}
    assert observed["excerpt"] in observed["text"]
    assert observed["status"] == "unconfirmed"
    assert observed["reason"] == "public_page_observation"
    assert "plans" not in observed and "entries" not in observed
    assert page_content(html, "public_page", "https://example.com/blog/article") == observed
    changed = page_content(html.replace("specific public", "updated public"), "public_page",
                           "https://example.com/blog/article")
    assert semantic_hash(changed) != semantic_hash(observed)
    partial = page_content(html, "public_page", "https://example.com/blog/article", complete=False)
    assert partial["reason"] == "capture_truncated"


def test_individual_page_ignores_skip_navigation_and_repeated_chrome():
    html = ('<title>Article title</title><body><a href="#content">Skip to content</a>'
            '<nav>All products and pricing</nav><main><a href="#content">Skip to content</a></main>'
            '<article><h1>Article title</h1><p>The product now supports image uploads from '
            'GitHub Actions with short-lived credentials.</p><p>The product now supports image uploads '
            'from GitHub Actions with short-lived credentials.</p></article>'
            '<footer>Join our newsletter</footer></body>')
    result = page_content(html, "public_page", "https://example.com/changelog/article")
    assert result["reason"] == "public_page_observation"
    assert result["excerpt"].startswith("Article title")
    assert "short-lived credentials" in result["excerpt"]
    assert "Skip to content" not in result["text"]
    assert "newsletter" not in result["text"]
    assert result["text"].count("GitHub Actions") == 1
    assert result["origin_date_literal"] is None
    assert result["origin_date_evidence"] is None


def test_individual_page_without_main_content_is_insufficient():
    result = page_content('<title>Article</title><body><a href="#main">Skip to content</a>'
                          '<main><a href="#main">Skip to content</a></main><footer>2026</footer></body>',
                          "public_page", "https://example.com/article")
    assert result["reason"] == "insufficient_main_content"
    assert result["excerpt"] == ""
    assert result["text"] == ""
    assert result["origin_date_literal"] is None


def test_individual_page_date_requires_literal_on_page():
    html = ('<article><h1>Release</h1><time datetime="2026-09-25">25 September</time>'
            '<p>The application now supports short-lived authentication for uploads.</p></article>')
    result = page_content(html, "public_page", "https://example.com/article")
    assert result["origin_date_literal"] == "25 September"
    assert result["origin_date_evidence"]["datetime_attribute"] == "2026-09-25"
    assert result.get("origin_reported_at") is None


def test_individual_page_hash_ignores_rule_metadata_but_detects_html_content_change():
    first = page_content('<article><h1>Update</h1><p>The product now supports '
                         'short-lived upload credentials.</p></article>', "public_page",
                         "https://example.com/article")
    same = {**first, "extractor_version": 999, "comparison_status": "older_rule"}
    assert public_content_hash(first) == public_content_hash(same)
    changed = page_content('<article><h1>Update</h1><p>The product now supports '
                           'a different upload method.</p></article>', "public_page",
                           "https://example.com/article")
    assert public_content_hash(first) != public_content_hash(changed)


def pricing(amount="10", currency="USD", period="per month", footer="2025", banner="Accept cookies"):
    return ("<header>Site menu</header><main><section class='plan'><h2>Pro</h2>"
            f"<p>{currency} {amount} {period}</p><p>Includes API access</p></section>"
            f"<div class='cookie-banner'>{banner}</div></main><footer>Copyright {footer}</footer>")


def test_trivial_html_changes_do_not_change_snapshot_hash():
    first = page_content(pricing(), "pricing_page", "https://example.com/pricing")
    second = page_content(pricing(footer="2026", banner="Accept all cookies"),
                          "pricing_page", "https://example.com/pricing")
    assert first["plans"][0]["confirmed"] is True
    assert semantic_hash(first) == semantic_hash(second)


def test_plain_text_changelog_is_preserved_without_invented_entries():
    content = page_content("Version 2: added export and fixed sync.", "release_notes",
                           "https://example.com/changelog")
    assert content["status"] == "unconfirmed"
    assert content["entries"] == []
    assert "added export" in content["text"]


def test_editorial_homepage_articles_are_not_release_notes():
    # This is a local fixture representing the failure mode of a consultancy homepage.
    html = ("<main><h1>Perspectives</h1><article><h2>AI in banking</h2>"
            "<time datetime='2026-09-15'>15 Sep</time><a href='/insights/ai-banking'>Read more</a>"
            "<p>Author: Alex. Read more about industry trends.</p></article></main>")
    result = page_content(html, "release_notes", "https://example.com/")
    assert result["status"] == "unconfirmed"
    assert result["reason"] == "release_context_missing"
    assert result["entries"] == []


def test_release_context_needs_specific_entry_link():
    missing = page_content("<main><h1>Changelog</h1><article><h2>Version 2</h2>"
                           "<p>Fixed sync.</p></article></main>", "release_notes",
                           "https://example.com/changelog")
    assert missing["entries"] == []
    assert missing["reason"] == "release_link_or_title_missing"


def test_incomplete_price_and_unverified_page_are_not_confirmed():
    incomplete = page_content(pricing(period=""), "pricing_page", "https://example.com/pricing")
    assert incomplete["status"] == "unconfirmed"
    assert incomplete["plans"][0]["confirmed"] is False
    wrong_page = page_content(pricing(), "pricing_page", "https://example.com/")
    assert wrong_page["status"] == "unconfirmed"
    assert wrong_page["reason"] == "pricing_context_missing"


def test_price_comparison_requires_same_currency_period_and_conditions():
    old = page_content(pricing(), "pricing_page", "https://example.com/pricing")
    newer = page_content(pricing(amount="12"), "pricing_page", "https://example.com/pricing")
    comparable = compare_pages(old, newer)
    assert comparable[0]["kind"] == "price_observed"
    assert comparable[0]["percent_change"] == "20.00"
    different_currency = page_content(pricing(amount="12", currency="EUR"),
                                      "pricing_page", "https://example.com/pricing")
    different_period = page_content(pricing(amount="12", period="per year"),
                                    "pricing_page", "https://example.com/pricing")
    assert compare_pages(old, different_currency)[0]["percent_change"] is None
    assert compare_pages(old, different_period)[0]["percent_change"] is None
    assert compare_pages(old, newer, before_trusted=False)[0]["kind"] == "text_changed_unconfirmed"
    bare_old = page_content("<main><section class='plan'><h2>Pro</h2><p>USD 10 per month</p></section></main>",
                            "pricing_page", "https://example.com/pricing")
    bare_new = page_content("<main><section class='plan'><h2>Pro</h2><p>USD 12 per month</p></section></main>",
                            "pricing_page", "https://example.com/pricing")
    assert bare_old["plans"][0]["conditions"] == ""
    assert compare_pages(bare_old, bare_new)[0]["percent_change"] is None
    ambiguous = page_content(pricing(amount="1,000"), "pricing_page", "https://example.com/pricing")
    assert ambiguous["status"] == "unconfirmed"


def test_changelog_preserves_entry_title_date_link_and_diff():
    old = page_content("<main><article><h2>Version 1</h2><time datetime='2026-01-01'>Jan 1</time>"
                       "<a href='/releases/1'>Details</a><p>Fixed sync.</p></article></main>",
                       "release_notes", "https://example.com/changelog")
    new = page_content("<main><article><h2>Version 2</h2><time datetime='2026-02-01'>Feb 1</time>"
                       "<a href='/releases/2'>Details</a><p>Added export.</p></article></main>",
                       "release_notes", "https://example.com/changelog")
    assert old["entries"][0]["url"] == "https://example.com/releases/1"
    assert old["entries"][0]["date"] == "2026-01-01"
    changes = compare_pages(old, new)
    assert {change["kind"] for change in changes} == {"entry_appeared", "entry_disappeared_from_page"}


def test_changelog_sibling_date_and_product_change_have_literal_provenance():
    html = ("<main><h1>Changelog</h1><ul><li><div>25 September</div><article>"
            "<h2><a href='/changelog/vcr-login-github-action'>"
            "Push images to Vercel Container Registry from GitHub Actions</a></h2>"
            "<p>The login action logs workflows in with GitHub OIDC, removing long-lived credentials.</p>"
            "</article></li></ul></main>")
    content = page_content(html, "release_notes", "https://example.com/changelog")
    assert content["status"] == "confirmed"
    assert len(content["entries"]) == 1
    entry = content["entries"][0]
    assert entry["date_evidence"] == "25 September"
    assert entry["title_evidence"] in html
    assert entry["url_evidence"] in html
    assert "logs workflows" in entry["evidence"]
    assert entry["url"] == "https://example.com/changelog/vcr-login-github-action"
    assert page_content(reparse_markup(html), "release_notes", "https://example.com/changelog")["text"] == content["text"]


def test_release_index_and_editorial_card_do_not_become_releases():
    index = ("<main><h1>Release Notes</h1><article><h2>PostgreSQL 17</h2>"
             "<time datetime='2026-09-25'>25 September</time>"
             "<a href='/docs/release/17'>Release notes</a>"
             "<p>Added documentation index links for older versions.</p></article></main>")
    editorial = ("<main><h1>Changelog</h1><article class='editorial'>"
                 "<h2>How teams work now</h2><time datetime='2026-09-25'>25 September</time>"
                 "<a href='/changelog/blog-post'>Read article</a>"
                 "<p>Author: Alex. Read more about how teams added new workflows.</p>"
                 "</article></main>")
    assert page_content(index, "release_notes", "https://example.com/docs/release/")["entries"] == []
    assert page_content(editorial, "release_notes", "https://example.com/changelog")["entries"] == []


def test_incomplete_large_pricing_never_confirms_plan_from_prefix():
    html = ("<main><h1>Pricing</h1><section class='plan'><h2>Pro</h2>"
            "<p>USD 10 per month</p><p>API access</p></section></main>" + " " * 900_000)
    content = page_content(html, "pricing_page", "https://example.com/pricing", complete=False)
    assert content["status"] == "partial"
    assert content["reason"] == "capture_truncated"
    assert "USD 10 per month" in content["plans"][0]["evidence"]
    no_plan = page_content("<main><h1>Pricing</h1><p>Choose a plan.</p></main>",
                           "pricing_page", "https://example.com/pricing", complete=False)
    assert no_plan["status"] == "unconfirmed"
    assert no_plan["plans"] == []


@pytest.mark.parametrize("declared", [1_100_000, None])
def test_bounded_capture_reads_only_prefix_with_or_without_content_length(monkeypatch, declared):
    body = b"<main><h1>Pricing</h1></main>" + b" " * 1_100_000
    class Response:
        status = 200
        length = declared
        offset = 0

        def getheaders(self):
            return [("Content-Type", "text/html")]

        def read(self, size):
            chunk = body[self.offset:self.offset + size]
            self.offset += len(chunk)
            return chunk

    response = Response()
    class Connection:
        def __init__(self, *_args, **_kwargs):
            pass

        def request(self, *_args, **_kwargs):
            pass

        def getresponse(self):
            return response

        def close(self):
            pass

    monkeypatch.setattr(http.client, "HTTPSConnection", Connection)
    status, headers, prefix = request_pinned_capture("https://example.com/pricing", "93.184.215.14")
    assert status == 200
    assert len(prefix) == 1_000_000
    assert response.offset <= 1_000_001
    assert headers["x-marketrift-capture-complete"] == "false"
    assert headers["x-marketrift-limit-kind"] == ("content_length" if declared else "actual_bytes")


def test_large_robots_is_not_partially_interpreted():
    calls = []
    def responder(url, _ip):
        calls.append(url)
        return 200, {"x-marketrift-capture-complete": "false"}, b"User-agent: *\nAllow: /\n"
    with pytest.raises(PageError, match="robots_unavailable"):
        fetch_public_page("https://example.com/pricing", lookup=dns("93.184.215.14"), request=responder)
    assert calls == ["https://example.com/robots.txt"]
