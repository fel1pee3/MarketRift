"""Opt-in, bounded browser observation of one public page; no tenant credentials here."""

import asyncio
import hashlib
import hmac
import os
import re
from datetime import UTC, datetime
from urllib.parse import urlsplit

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

from .web_pages import (
    PUBLIC_PAGE_EXTRACTOR_VERSION,
    USER_AGENT,
    PageError,
    canonical_url,
    capture_public_page,
    resolve_public,
)

RENDERED_RULE_VERSION = PUBLIC_PAGE_EXTRACTOR_VERSION + 1
MAX_REQUESTS = 35
MAX_RESOURCE_BYTES = 1_000_000
MAX_TOTAL_BYTES = 6_000_000
MAX_TEXT = 30_000
SEMANTIC_TEXT = 1_500
render_gate = asyncio.Semaphore(1)
app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)


class RenderInput(BaseModel):
    url: str = Field(min_length=12, max_length=2048)
    last_checked_at: datetime | None = None


def extract_visible_article(title: str, candidates: list[dict], final_url: str,
                            *, complete: bool, limit_kind: str | None) -> dict:
    """Only visible article/main text from the page itself can become evidence."""
    viable = [item for item in candidates if item.get("tag") in ("ARTICLE", "MAIN")
              and isinstance(item.get("text"), str)]
    viable.sort(key=lambda item: (item["tag"] == "ARTICLE", len(item["text"])), reverse=True)
    selected = viable[0] if viable else None
    lines = []
    for line in (selected["text"].splitlines() if selected else []):
        line = re.sub(r"\s+", " ", line).strip()
        if (not line or line.lower() in ("skip to content", "pular para o conteúdo")
                or line in lines):
            continue
        lines.append(line)
    text = "\n".join(lines)[:MAX_TEXT]
    title = re.sub(r"\s+", " ", title).strip()[:200]
    prose = sum(len(line) for line in lines if len(line) >= 30 and re.search(r"[.!?]", line))
    useful = bool(title and selected and prose >= 100)
    if not useful:
        raise PageError("insufficient_main_content")
    date = selected.get("time") if selected else None
    visible = re.sub(r"\s+", " ", str(date.get("text") or "")).strip()[:100] if isinstance(date, dict) else ""
    attribute = str(date.get("datetime") or "")[:100] if isinstance(date, dict) else ""
    literal = (visible or attribute or None) if useful else None
    evidence = {"element": "time", "text": visible or None,
                "datetime_attribute": attribute or None} if literal else None
    return {"kind": "public_page", "capture_method": "rendered_dom", "extractor_version": RENDERED_RULE_VERSION,
            "title": title or None, "text": text[:SEMANTIC_TEXT] if useful else "",
            "excerpt": text[:500] if useful else "", "observed_text_hash": hashlib.sha256(text.encode()).hexdigest(),
            "origin_date_literal": literal, "origin_date_evidence": evidence,
            "status": "unconfirmed", "reason": ("render_subresources_blocked" if not complete
                                                     else "public_page_observation"),
            "capture_complete": complete, "capture_limit_kind": limit_kind,
            "dom_observed_at": datetime.now(UTC).isoformat(), "final_url": final_url}


async def render_public_page(url: str, last_checked_at: datetime | None = None,
                             *, test_base_url: str | None = None, browser_channel: str | None = None) -> dict:
    from playwright.async_api import Error as PlaywrightError
    from playwright.async_api import async_playwright

    if test_base_url is None:
        canonical = canonical_url(url)
        host = urlsplit(canonical).hostname or ""
        # The existing collector verifies robots, TLS, redirects, content type and a bounded document.
        final_url, _, complete, _ = await asyncio.to_thread(capture_public_page, canonical,
                                                               last_checked_at=last_checked_at)
        if not complete:
            raise PageError("response_too_large")
        if urlsplit(final_url).hostname != host:
            raise PageError("unsafe_destination")
        pinned_ip = resolve_public(host)
        navigation_url = final_url
    else:
        if os.getenv("MARKETRIFT_TEST_MODE") != "1":
            raise PageError("test_transport_disabled")
        parsed = urlsplit(test_base_url)
        if parsed.scheme != "http" or parsed.hostname != "127.0.0.1" or not parsed.port:
            raise PageError("invalid_test_transport")
        host = "127.0.0.1"
        pinned_ip = host
        navigation_url = test_base_url

    requested = 0
    downloaded = 0
    resource_bytes: dict[str, int] = {}
    blocked = False
    blocked_document = False
    hit_request_cap = False
    limit_kind = None
    redirects = 0
    stopped = False
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(headless=True, channel=browser_channel,
            args=[f"--host-resolver-rules=MAP {host} {pinned_ip}, MAP * ~NOTFOUND",
                  "--no-proxy-server", "--js-flags=--max-old-space-size=128"])
        try:
            context = await browser.new_context(service_workers="block", accept_downloads=False,
                java_script_enabled=True, ignore_https_errors=False, user_agent=USER_AGENT)
            page = await context.new_page()
            page.set_default_timeout(8_000)

            async def route_request(route):
                nonlocal requested, blocked, blocked_document, hit_request_cap
                requested += 1
                target = urlsplit(route.request.url)
                test_local = test_base_url is not None and target.scheme == "http" and target.hostname == "127.0.0.1"
                valid = ((target.scheme == "https" and target.hostname == host) or test_local)
                valid = valid and not target.username and not target.password and route.request.method == "GET"
                valid = valid and route.request.resource_type in ("document", "script", "stylesheet", "xhr", "fetch")
                if route.request.resource_type == "document" and route.request.url != navigation_url:
                    valid = False
                if requested > MAX_REQUESTS:
                    hit_request_cap = True
                    valid = False
                if not valid:
                    blocked = True
                    if route.request.resource_type == "document":
                        blocked_document = True
                    await route.abort("blockedbyclient")
                else:
                    await route.continue_()

            await context.route("**/*", route_request)
            await context.route_web_socket("**/*", lambda socket: socket.close())

            cdp = await context.new_cdp_session(page)
            await cdp.send("Network.enable")

            async def stop_page():
                try:
                    await page.evaluate("window.stop()")
                except PlaywrightError:
                    pass

            def on_data(event):
                nonlocal downloaded, limit_kind, stopped
                amount = int(event.get("dataLength", 0))
                downloaded += amount
                request_id = str(event.get("requestId", ""))
                resource_bytes[request_id] = resource_bytes.get(request_id, 0) + amount
                if resource_bytes[request_id] > MAX_RESOURCE_BYTES:
                    limit_kind = "resource_bytes"
                elif downloaded > MAX_TOTAL_BYTES:
                    limit_kind = "total_bytes"
                if limit_kind and not stopped:
                    stopped = True
                    asyncio.create_task(stop_page())

            cdp.on("Network.dataReceived", on_data)

            async def watch_response(response):
                nonlocal limit_kind, stopped, blocked_document
                if response.request.resource_type == "document" and response.status in (301, 302, 303, 307, 308):
                    location = response.headers.get("location", "")
                    target = urlsplit(location)
                    if target.scheme not in ("", "https" if test_base_url is None else "http") or \
                            (target.hostname and target.hostname != host):
                        blocked_document = True
                declared = response.headers.get("content-length", "")
                if declared.isdigit() and int(declared) > MAX_RESOURCE_BYTES:
                    limit_kind = "resource_bytes"
                    stopped = True
                if limit_kind:
                    await stop_page()

            page.on("response", lambda response: asyncio.create_task(watch_response(response)))

            def count_navigation(frame):
                nonlocal redirects
                if frame == page.main_frame:
                    redirects += 1

            page.on("framenavigated", count_navigation)
            response = await page.goto(navigation_url, wait_until="domcontentloaded", timeout=8_000)
            if response is None or response.status in (401, 403):
                raise PageError("access_denied")
            if response.status != 200:
                raise PageError("http_failure")
            await page.wait_for_timeout(3_000)
            final_url = page.url
            if redirects > 3:
                raise PageError("redirect_limit")
            if final_url.split("#", 1)[0] != navigation_url:
                raise PageError("unsafe_destination")
            if test_base_url is None:
                canonical_url(final_url, expected_host=host)
            elif urlsplit(final_url).hostname != "127.0.0.1":
                raise PageError("unsafe_destination")
            if stopped:
                raise PageError("render_budget_exceeded")
            result = await page.evaluate("""() => ({
              title: document.title,
              candidates: [...document.querySelectorAll('article,main,[role="main"]')]
                .filter(e => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden')
                .slice(0, 12).map(e => ({tag:e.tagName, text:(e.innerText||'').slice(0,30000),
                  time:(() => {const t=e.querySelector('time'); return t ?
                    {text:(t.innerText||'').slice(0,100),datetime:(t.getAttribute('datetime')||'').slice(0,100)} : null;})()}))
            })""")
            return {"final_url": final_url,
                    "content": extract_visible_article(result.get("title") or "", result.get("candidates") or [],
                                                       final_url, complete=not blocked and not hit_request_cap,
                                                       limit_kind=None),
                    "complete": not blocked and not hit_request_cap, "limit_kind": None}
        except PlaywrightError as error:
            if stopped or limit_kind in ("resource_bytes", "total_bytes"):
                raise PageError("render_budget_exceeded") from error
            if blocked_document:
                raise PageError("unsafe_destination") from error
            if "Timeout" in type(error).__name__:
                raise PageError("render_timeout") from error
            raise PageError("renderer_failure") from error
        finally:
            await browser.close()


def e2e_rendered_public_page(url: str, *, last_checked_at: datetime | None = None) -> dict:
    """Controlled E2E browser; never resolves a public origin during a test."""
    if os.getenv("MARKETRIFT_TEST_MODE") != "1":
        raise PageError("test_transport_disabled")
    canonical = canonical_url(url, expected_host="example.com")
    base = os.getenv("WEB_PAGE_TEST_BASE_URL", "")
    parts = urlsplit(base)
    if parts.scheme != "http" or parts.hostname != "127.0.0.1" or not parts.port:
        raise PageError("invalid_test_transport")
    observed = asyncio.run(render_public_page(canonical, last_checked_at,
        test_base_url=f"http://127.0.0.1:{parts.port}/web-page-rendered{urlsplit(canonical).path}",
        browser_channel="chrome" if os.name == "nt" else None))
    observed["final_url"] = canonical
    observed["content"]["final_url"] = canonical
    return observed


@app.post("/render")
async def render(request: RenderInput, authorization: str | None = Header(default=None)):
    expected = os.getenv("RENDERER_INTERNAL_TOKEN", "")
    if not expected:
        raise HTTPException(503, detail={"error_code": "renderer_not_configured"})
    if not authorization or not hmac.compare_digest(authorization, f"Bearer {expected}"):
        raise HTTPException(401, detail={"error_code": "renderer_unauthorized"})
    try:
        async with render_gate:
            return await asyncio.wait_for(render_public_page(request.url, request.last_checked_at), timeout=22)
    except TimeoutError:
        raise HTTPException(503, detail={"error_code": "render_timeout"}) from None
    except PageError as error:
        raise HTTPException(422, detail={"error_code": error.code,
                                         "retry_at": error.retry_at.isoformat() if error.retry_at else None}) from None
