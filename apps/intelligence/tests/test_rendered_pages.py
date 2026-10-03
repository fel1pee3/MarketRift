"""Deterministic local pages for the opt-in browser capture; no public requests."""

import asyncio
import hashlib
import threading
from datetime import UTC, datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from marketrift_intelligence.rendered_pages import extract_visible_article, render_public_page
from marketrift_intelligence.web_pages import PageError


class Site(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_GET(self):
        if self.path == "/redirect":
            self.send_response(302)
            self.send_header("Location", "http://169.254.169.254/latest/meta-data/")
            self.end_headers()
            return
        if self.path == "/oversize":
            body = ("<title>Large article</title><article><p>" + "A sentence with a clear point. " * 50_000
                    + "</p></article>").encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionAbortedError):
                pass
            return
        if self.path == "/slow":
            import time
            time.sleep(9)
        html = {
            "/rendered": "<title>Actual product update</title><nav>Skip to content</nav>"
                         "<article id='main'></article><script>document.getElementById('main').innerHTML="
                         "'<p>The new registry login action now authenticates a workflow without a stored token. "
                         "This update replaces long lived credentials in automated deployments.</p>"
                         "<time datetime=\"2026-09-25\">25 September</time>'</script>",
            "/empty": "<title>Navigation only</title><nav>Skip to content</nav><article></article>",
            "/static": "<title>Static article</title><article><p>The product now supports bounded uploads "
                       "for development teams. Users can upload a file and inspect the new result "
                       "without any browser extension.</p></article>",
            "/external": "<title>External subresource</title><article><p>The new product setting "
                         "helps teams inspect evidence and compare a previous version with a newer "
                         "version. This article is the source of that observation.</p></article>"
                         "<script src='http://169.254.169.254/secret.js'></script>",
            "/slow": "<title>Late</title><article><p>This page responds after the time limit. "
                     "It cannot be used as evidence for any publication or product update.</p></article>",
        }.get(self.path, "<title>Unknown</title>")
        encoded = html.encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        try:
            self.wfile.write(encoded)
        except (BrokenPipeError, ConnectionAbortedError):
            pass


@pytest.fixture(scope="module")
def local_site():
    server = ThreadingHTTPServer(("127.0.0.1", 0), Site)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}"
    finally:
        server.shutdown()
        thread.join(timeout=2)


def test_literal_article_and_date():
    text = "The registry action now authenticates workflows without a stored token. " \
           "This improves the way a release can be deployed from GitHub Actions."
    result = extract_visible_article("Product update", [{"tag": "ARTICLE", "text": text,
        "time": {"text": "25 September", "datetime": "2026-09-25"}}],
        "https://example.com/update", complete=True, limit_kind=None)
    assert result["text"] == text
    assert result["origin_date_literal"] == "25 September"
    assert result["origin_date_evidence"]["datetime_attribute"] == "2026-09-25"
    assert result["observed_text_hash"] == hashlib.sha256(text.encode()).hexdigest()
    assert result["capture_method"] == "rendered_dom"


def test_navigation_only_is_not_evidence():
    with pytest.raises(PageError, match="insufficient_main_content"):
        extract_visible_article("Page", [{"tag": "ARTICLE", "text": "Skip to content", "time": None}],
                                "https://example.com", complete=True, limit_kind=None)


@pytest.mark.parametrize("path,has_date", [("rendered", True), ("static", False), ("external", False)])
def test_controlled_browser(monkeypatch, local_site, path, has_date):
    monkeypatch.setenv("MARKETRIFT_TEST_MODE", "1")
    result = asyncio.run(render_public_page("https://example.com/update", datetime.now(UTC),
        test_base_url=f"{local_site}/{path}", browser_channel="chrome"))
    assert "Skip to content" not in result["content"]["excerpt"]
    assert len(result["content"]["excerpt"]) > 100
    assert bool(result["content"]["origin_date_evidence"]) is has_date
    assert result["content"]["status"] == "unconfirmed"
    if path == "external":
        assert result["complete"] is False


@pytest.mark.parametrize("path,error", [("empty", "insufficient_main_content"),
                                        ("redirect", "unsafe_destination"),
                                        ("slow", "render_timeout"),
                                        ("oversize", "render_budget_exceeded")])
def test_controlled_browser_rejects(monkeypatch, local_site, path, error):
    monkeypatch.setenv("MARKETRIFT_TEST_MODE", "1")
    with pytest.raises(PageError, match=error):
        asyncio.run(render_public_page("https://example.com/update", test_base_url=f"{local_site}/{path}",
                                       browser_channel="chrome"))
