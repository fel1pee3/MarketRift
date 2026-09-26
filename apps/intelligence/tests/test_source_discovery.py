"""Deterministic source discovery, provenance and bounded network tests."""

import socket

import pytest

from marketrift_intelligence.source_discovery import (
    DiscoveryError,
    classify,
    collect,
    request_discovery_pinned,
    safe_link,
    validate_job,
)


def dns(address="93.184.215.14"):
    return lambda _host, _port, **_kwargs: [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (address, 443))]


def site(robots=b"User-agent: *\nAllow: /\n"):
    requested = []

    def request(url, _ip):
        requested.append(url)
        path = url.split("example.com", 1)[1]
        if path == "/robots.txt":
            return 200, {}, robots
        if path == "/":
            return 200, {"content-type": "text/html"}, (b'<a href="/pricing">Pricing</a>'
                b'<a href="/changelog">Releases</a>'
                b'<a href="/pricing">Plans</a>'
                b'<a href="https://instagram.com/example">Instagram</a>'
                b'<a href="https://thirdparty.com/pricing">Pricing partner</a>'
                b'<a href="https://example.co/pricing">Example pricing</a>'
                b'<a href="https://github.com/example/repo">Forum</a>'
                b'<link rel="alternate" href="/feed.xml" type="application/rss+xml">')
        if path == "/sitemap.xml":
            return 200, {"content-type": "application/xml"}, (b'<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
                b'<url><loc>https://example.com/pricing</loc></url>'
                b'<url><loc>https://example.com/docs</loc></url></urlset>')
        if path == "/feed.xml":
            return 200, {"content-type": "application/rss+xml"}, (b'<rss><channel><item>'
                b'<link>https://example.com/blog/release</link></item></channel></rss>')
        if path == "/pricing":
            return 200, {"content-type": "text/html"}, b'<a href="/support">Support</a>'
        return 404, {}, b""

    return request, requested


def test_limited_site_classifies_without_fetching_external_or_duplicates():
    request, requested = site()
    candidates, pages, failures = collect("example.com", [], lookup=dns(), request=request)
    urls = {item.url: item for item in candidates}
    assert len(urls) == len(candidates)
    assert pages <= 7
    assert failures == []
    assert urls["https://example.com/pricing"].suggested_type == "pricing_page"
    assert urls["https://example.com/changelog"].suggested_type == "release_notes"
    assert urls["https://example.com/docs"].suggested_type == "documentation"
    assert urls["https://example.com/feed.xml"].category == "news"
    assert urls["https://instagram.com/example"].confidence == "linked_external"
    assert urls["https://thirdparty.com/pricing"].confidence == "ambiguous"
    assert urls["https://example.co/pricing"].confidence == "ambiguous"
    assert urls["https://github.com/example/repo"].suggested_type == "github_repository"
    assert all(url.startswith("https://example.com/") for url in requested)


def test_robots_disallow_homepage():
    request, requested = site(b"User-agent: *\nDisallow: /\n")
    with pytest.raises(DiscoveryError, match="robots_disallowed"):
        collect("example.com", [], lookup=dns(), request=request)
    assert requested == ["https://example.com/robots.txt"]


def test_private_redirect_not_followed():
    requested = []

    def request(url, _ip):
        requested.append(url)
        if url.endswith("robots.txt"):
            return 404, {}, b""
        return 302, {"location": "https://169.254.169.254/latest/meta-data"}, b""

    with pytest.raises(Exception, match="unsafe_destination"):
        collect("example.com", [], lookup=dns(), request=request)
    assert len(requested) == 2


def test_network_failure_and_private_dns():
    with pytest.raises(Exception, match="unsafe_destination"):
        collect("example.com", [], lookup=dns("127.0.0.1"))
    def request(_url, _ip):
        raise OSError("network down")
    with pytest.raises(DiscoveryError, match="robots_unavailable"):
        collect("example.com", [], lookup=dns(), request=request)


def test_rate_limit_is_recorded_and_stops_before_more_requests():
    calls = []

    def request(url, _ip):
        calls.append(url)
        if url.endswith("robots.txt"):
            return 200, {}, b"User-agent: *\nAllow: /\n"
        return 429, {"retry-after": "90"}, b""

    with pytest.raises(DiscoveryError, match="rate_limited") as failure:
        collect("example.com", [], lookup=dns(), request=request)
    assert failure.value.retry_at is not None
    assert len(calls) == 2


def test_similarity_and_unsafe_links_are_not_official():
    assert classify("https://example.co/pricing", "pricing", "example.com")[2] == "ambiguous"
    assert safe_link("https://example.com/", "http://localhost/admin") is None
    assert safe_link("https://example.com/", "https://169.254.169.254/meta") is None


def test_contract_rejects_wrong_key():
    payload = {"version": 1, "tenant_id": "00000000-0000-4000-8000-000000000001",
               "product_id": "00000000-0000-4000-8000-000000000002",
               "run_id": "00000000-0000-4000-8000-000000000003", "identity_version": 1,
               "idempotency_key": "source-discovery-00000000-0000-4000-8000-000000000003-v1"}
    assert validate_job(payload) == payload
    with pytest.raises(DiscoveryError, match="invalid_job_key"):
        validate_job({**payload, "idempotency_key": "source-discovery-00000000-0000-4000-8000-000000000002-v1"})


def test_oversized_homepage_is_skipped_without_parsing_partial_links():
    request, seen = site()

    def oversized(url, ip):
        if url == "https://example.com/":
            return 200, {"content-type": "text/html", "content-length": "1000001"}, \
                b'<a href="/pricing-from-partial">Pricing</a>'
        return request(url, ip)

    candidates, pages, failures = collect("example.com", [], lookup=dns(), request=oversized)
    assert pages >= 3
    assert failures == [{"resource": "homepage", "url": "https://example.com/",
                         "code": "response_too_large", "limit_kind": "content_length"}]
    assert "https://example.com/pricing-from-partial" not in {item.url for item in candidates}
    assert "https://example.com/docs" in {item.url for item in candidates}
    assert seen  # sitemap was still read


def test_oversized_sitemap_and_feed_are_partial_not_fatal():
    request, _seen = site()

    def oversized(url, ip):
        if url.endswith("sitemap.xml"):
            return 200, {"content-type": "application/xml"}, b"x" * 1_000_001
        if url.endswith("feed.xml"):
            return 200, {"content-type": "application/xml", "content-length": "1000001"}, b"<rss/>"
        return request(url, ip)

    candidates, pages, failures = collect("example.com", [], lookup=dns(), request=oversized)
    assert pages <= 7
    assert {failure["resource"] for failure in failures} == {"sitemap", "feed"}
    assert {failure["limit_kind"] for failure in failures} == {"actual_bytes", "content_length"}
    assert "https://example.com/docs" not in {item.url for item in candidates}
    assert "https://example.com/pricing" in {item.url for item in candidates}


def test_oversized_or_invalid_robots_stops_before_homepage():
    for robots in (b"User-agent: *\n" + b"x" * 256_000, b"<html>not robots</html>"):
        request, seen = site(robots)
        with pytest.raises(DiscoveryError) as failure:
            collect("example.com", [], lookup=dns(), request=request)
        assert failure.value.code in ("robots_too_large", "robots_invalid")
        assert failure.value.attempted == 1
        assert seen == ["https://example.com/robots.txt"]


def test_interrupted_optional_response_records_partial_coverage():
    request, _seen = site()

    def interrupted(url, ip):
        if url.endswith("sitemap.xml"):
            raise OSError("connection ended")
        return request(url, ip)

    candidates, pages, failures = collect("example.com", [], lookup=dns(), request=interrupted)
    assert pages >= 3
    assert failures[0]["resource"] == "sitemap"
    assert failures[0]["code"] == "network_failure"
    assert "https://example.com/pricing" in {item.url for item in candidates}


def test_unverified_known_url_does_not_become_confirmed_official_link():
    request, _seen = site()
    candidates, _pages, _failures = collect("example.com", ["https://example.com/pricing-special",
                                                      "https://example.com/pricing"],
                                           lookup=dns(), request=request)
    known = next(item for item in candidates if item.url.endswith("pricing-special"))
    assert known.method == "known_url"
    assert known.confidence == "ambiguous"
    verified = next(item for item in candidates if item.url == "https://example.com/pricing")
    assert verified.method == "homepage"
    assert verified.confidence == "official_host"


def test_transport_streams_without_content_length_and_stops_at_byte_cap(monkeypatch):
    import marketrift_intelligence.source_discovery as discovery

    class Response:
        length = None
        status = 200

        def __init__(self):
            self.delivered = 0
            self.read_sizes = []

        def getheaders(self):
            return [("content-type", "text/html")]

        def read(self, size):
            self.read_sizes.append(size)
            amount = min(size, 1_000_010 - self.delivered)
            self.delivered += amount
            return b"x" * amount

    response = Response()

    class Connection:
        sock = None

        def __init__(self, *_args, **_kwargs):
            pass

        def connect(self):
            pass

        def request(self, *_args, **_kwargs):
            pass

        def getresponse(self):
            return response

        def close(self):
            pass

    monkeypatch.setattr(discovery.http.client, "HTTPSConnection", Connection)
    with pytest.raises(DiscoveryError, match="response_too_large") as failure:
        request_discovery_pinned("https://example.com/", "93.184.215.14")
    assert failure.value.limit_kind == "actual_bytes"
    assert response.delivered == 1_000_001
    assert max(response.read_sizes) <= 65_536


@pytest.mark.parametrize("declared, expected", [(1_000_001, "response_too_large"),
                                                (100, "response_truncated")])
def test_transport_rejects_declared_oversize_and_interrupted_body(monkeypatch, declared, expected):
    import marketrift_intelligence.source_discovery as discovery

    class Response:
        length = declared
        status = 200
        calls = 0

        def getheaders(self):
            return [("content-length", str(declared))]

        def read(self, _size):
            self.calls += 1
            return b"short" if self.calls == 1 else b""

    response = Response()

    class Connection:
        sock = None

        def __init__(self, *_args, **_kwargs):
            pass

        def connect(self):
            pass

        def request(self, *_args, **_kwargs):
            pass

        def getresponse(self):
            return response

        def close(self):
            pass

    monkeypatch.setattr(discovery.http.client, "HTTPSConnection", Connection)
    with pytest.raises(DiscoveryError, match=expected):
        request_discovery_pinned("https://example.com/", "93.184.215.14")
    assert response.calls == (0 if declared > 1_000_000 else 2)


def test_transport_preserves_rate_limit_headers_without_reading_error_body(monkeypatch):
    import marketrift_intelligence.source_discovery as discovery

    class Response:
        status = 429
        length = 9_000_000

        def getheaders(self):
            return [("retry-after", "90"), ("content-length", "9000000")]

        def read(self, _size):
            raise AssertionError("rate-limit body must not be read")

    class Connection:
        sock = None

        def __init__(self, *_args, **_kwargs):
            pass

        def connect(self):
            pass

        def request(self, *_args, **_kwargs):
            pass

        def getresponse(self):
            return Response()

        def close(self):
            pass

    monkeypatch.setattr(discovery.http.client, "HTTPSConnection", Connection)
    status, headers, body = request_discovery_pinned("https://example.com/", "93.184.215.14")
    assert status == 429
    assert headers["retry-after"] == "90"
    assert body == b""
