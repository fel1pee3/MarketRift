"""Bounded public page capture; no model calls and no arbitrary internal network access."""

import asyncio
import hashlib
import http.client
import ipaddress
import json
import os
import re
import socket
import ssl
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from decimal import Decimal, InvalidOperation
from email.utils import parsedate_to_datetime
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urljoin, urlsplit, urlunsplit
from urllib.robotparser import RobotFileParser

import psycopg
from jsonschema import Draft202012Validator, FormatChecker

SCHEMA = json.loads((Path(__file__).resolve().parents[3] /
                     "packages/contracts/check-web-page-job.v1.schema.json").read_text(encoding="utf-8"))
VALIDATOR = Draft202012Validator(SCHEMA, format_checker=FormatChecker())
USER_AGENT = "MarketRiftPublicPageMonitor/1.0"
MAX_BYTES = 1_000_000
MAX_TEXT = 30_000
BLOCKED_WORDS = ("cookie", "consent", "banner", "newsletter", "footer", "navigation", "overlay", "modal")
PRICE = re.compile(r"(?<!\w)(USD|BRL|EUR|GBP|R\$|€|£)\s*(\d+(?:[.,]\d{1,2})?)(?![\d.,])", re.IGNORECASE)
PERIOD = re.compile(r"(?:\b(?:per\s+month|monthly|mensal|por\s+m[eê]s|"
                    r"per\s+year|yearly|annually|anual|por\s+ano)\b|/(?:month|mo|m[eê]s|year)\b)",
                    re.IGNORECASE)
RELEASE_CONTEXT = re.compile(r"(?:changelog|release[-_/ ]?notes?|version[-_/ ]?history|"
                             r"notas? de vers[aã]o|hist[oó]rico de vers[oõ]es)", re.IGNORECASE)
RELEASE_EVIDENCE = re.compile(r"(?:\b(?:release|version|v\d+(?:\.\d+)*|fixed|added|improved|"
                              r"changed|shipped|corrigid[oa]|adicionad[oa]|lan[cç]ad[oa]|"
                              r"atualizad[oa])\b)", re.IGNORECASE)
PRICING_CONTEXT = re.compile(r"(?:pricing|prices|plans?[-_/ ]?(?:and[-_/ ]?)?pricing|"
                             r"pre[cç]os?|planos?)", re.IGNORECASE)
EXTRACTOR_VERSION = 2


class PageError(Exception):
    def __init__(self, code: str, retry_at: datetime | None = None):
        super().__init__(code)
        self.code = code
        self.retry_at = retry_at


def canonical_url(value: str, expected_host: str | None = None) -> str:
    if len(value) > 2048 or any(ord(character) < 32 for character in value):
        raise PageError("invalid_url")
    parsed = urlsplit(value)
    host = (parsed.hostname or "").lower()
    try:
        port = parsed.port
    except ValueError as error:
        raise PageError("invalid_url") from error
    if (parsed.scheme != "https" or not host or parsed.username or parsed.password or
            port not in (None, 443) or not re.fullmatch(r"[a-z0-9.-]+", host) or
            "." not in host or host.endswith((".", ".local", ".internal", ".invalid", ".test")) or
            host == "localhost" or parsed.query or parsed.fragment or expected_host and host != expected_host):
        raise PageError("unsafe_destination")
    try:
        ipaddress.ip_address(host)
    except ValueError:
        pass
    else:
        raise PageError("unsafe_destination")
    return urlunsplit(("https", host, parsed.path or "/", "", ""))


def resolve_public(host: str, lookup: Callable = socket.getaddrinfo) -> str:
    try:
        answers = lookup(host, 443, type=socket.SOCK_STREAM)
    except (OSError, ValueError) as error:
        raise PageError("dns_failure") from error
    addresses = [row[4][0] for row in answers]
    if not addresses or len(addresses) > 32:
        raise PageError("dns_failure")
    try:
        parsed = [ipaddress.ip_address(address) for address in addresses]
    except ValueError as error:
        raise PageError("dns_failure") from error
    if any(not address.is_global for address in parsed):
        raise PageError("unsafe_destination")
    return str(parsed[0])


def request_pinned(url: str, ip: str) -> tuple[int, dict[str, str], bytes]:
    parts = urlsplit(url)
    host = parts.hostname or ""
    connection = http.client.HTTPSConnection(host, 443, timeout=8, context=ssl.create_default_context())
    # HTTPSConnection still verifies the original hostname, but opens the socket to the checked IP.
    connection._create_connection = lambda _address, timeout, source_address=None: socket.create_connection(
        (ip, 443), timeout, source_address)
    try:
        connection.request("GET", parts.path + ("?" + parts.query if parts.query else ""), headers={
            "Host": host, "User-Agent": USER_AGENT, "Accept": "text/html, text/plain;q=0.8",
            "Accept-Encoding": "identity", "Connection": "close"})
        response = connection.getresponse()
        if response.length is not None and response.length > MAX_BYTES:
            raise PageError("response_too_large")
        body = response.read(MAX_BYTES + 1)
        if len(body) > MAX_BYTES:
            raise PageError("response_too_large")
        return response.status, {key.lower(): value for key, value in response.getheaders()}, body
    except (OSError, ssl.SSLError, http.client.HTTPException) as error:
        raise PageError("network_failure") from error
    finally:
        connection.close()


def retry_after(headers: dict[str, str]) -> datetime | None:
    raw = headers.get("retry-after")
    if not raw:
        return None
    if raw.isdigit():
        return datetime.now(UTC) + timedelta(seconds=min(int(raw), 86400))
    try:
        parsed = parsedate_to_datetime(raw)
        return parsed.astimezone(UTC) if parsed.tzinfo else None
    except (ValueError, TypeError):
        return None


def fetch_public_page(start_url: str, *, lookup: Callable = socket.getaddrinfo,
                      request: Callable = request_pinned,
                      last_checked_at: datetime | None = None) -> tuple[str, str]:
    """Fetch robots and one HTML page, pinning every connection to a checked public IP."""
    url = canonical_url(start_url)
    host = urlsplit(url).hostname or ""
    ip = resolve_public(host, lookup)
    robots_url = f"https://{host}/robots.txt"
    status, headers, body = request(robots_url, ip)
    if status == 404:
        pass
    elif status != 200:
        raise PageError("robots_unavailable", retry_after(headers))
    else:
        parser = RobotFileParser()
        parser.parse(body.decode("utf-8", errors="replace").splitlines())
        if not parser.can_fetch(USER_AGENT, url):
            raise PageError("robots_disallowed")
        delay = parser.crawl_delay(USER_AGENT)
        if delay and last_checked_at and last_checked_at + timedelta(seconds=delay) > datetime.now(UTC):
            raise PageError("robots_crawl_delay", last_checked_at + timedelta(seconds=delay))
    for _ in range(3):
        ip = resolve_public(host, lookup)
        status, headers, body = request(url, ip)
        if status in (301, 302, 303, 307, 308):
            location = headers.get("location")
            if not location:
                raise PageError("redirect_without_location")
            url = canonical_url(urljoin(url, location), expected_host=host)
            if status == 303:
                raise PageError("unsupported_redirect")
            continue
        if status in (401, 403):
            raise PageError("access_denied")
        if status in (404, 410):
            raise PageError("not_found")
        if status in (429, 503):
            raise PageError("rate_limited", retry_after(headers) or datetime.now(UTC) + timedelta(minutes=5))
        if status != 200:
            raise PageError("http_failure")
        if headers.get("content-encoding", "identity").lower() not in ("identity", ""):
            raise PageError("unsupported_encoding")
        content_type = headers.get("content-type", "").lower()
        if not content_type.startswith(("text/html", "text/plain")):
            raise PageError("unsupported_content_type")
        charset = re.search(r"charset=([a-z0-9_-]+)", content_type)
        try:
            return url, body.decode(charset.group(1) if charset else "utf-8", errors="replace")
        except LookupError as error:
            raise PageError("unsupported_charset") from error
    raise PageError("redirect_limit")


def e2e_fetch_public_page(start_url: str, *, last_checked_at: datetime | None = None) -> tuple[str, str]:
    """E2E-only transport. The public URL still passes the normal URL and redirect checks."""
    if os.getenv("MARKETRIFT_TEST_MODE") != "1":
        raise PageError("test_transport_disabled")
    raw = os.getenv("WEB_PAGE_TEST_BASE_URL", "")
    parsed = urlsplit(raw)
    if parsed.scheme != "http" or parsed.hostname != "127.0.0.1" or not parsed.port or parsed.path not in ("", "/"):
        raise PageError("invalid_test_transport")

    def lookup(_host, _port, **_kwargs):
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.215.14", 443))]

    def request(url: str, _ip: str) -> tuple[int, dict[str, str], bytes]:
        if urlsplit(url).hostname != "example.com":
            raise PageError("invalid_test_host")
        connection = http.client.HTTPConnection("127.0.0.1", parsed.port, timeout=5)
        try:
            connection.request("GET", "/web-page" + urlsplit(url).path)
            response = connection.getresponse()
            body = response.read(MAX_BYTES + 1)
            if len(body) > MAX_BYTES:
                raise PageError("response_too_large")
            return response.status, {key.lower(): value for key, value in response.getheaders()}, body
        finally:
            connection.close()

    return fetch_public_page(start_url, lookup=lookup, request=request, last_checked_at=last_checked_at)


@dataclass
class Node:
    tag: str
    attrs: dict[str, str] = field(default_factory=dict)
    children: list["Node | str"] = field(default_factory=list)


class TreeParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = Node("root")
        self.stack = [self.root]

    def handle_starttag(self, tag, attrs):
        node = Node(tag, {key: value or "" for key, value in attrs})
        self.stack[-1].children.append(node)
        if tag not in ("br", "hr", "img", "meta", "link", "input", "source", "wbr"):
            self.stack.append(node)

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if self.stack[-1].tag == tag:
            self.stack.pop()

    def handle_endtag(self, tag):
        for index in range(len(self.stack) - 1, 0, -1):
            if self.stack[index].tag == tag:
                del self.stack[index:]
                break

    def handle_data(self, data):
        self.stack[-1].children.append(data)


def ignored(node: Node) -> bool:
    marker = (node.attrs.get("class", "") + " " + node.attrs.get("id", "")).lower()
    return (node.tag in ("script", "style", "noscript", "svg", "nav", "footer", "header", "form") or
            any(word in marker for word in BLOCKED_WORDS) or
            node.attrs.get("hidden") is not None or "display:none" in node.attrs.get("style", "").replace(" ", ""))


def descendants(node: Node, tag: str | None = None):
    for child in node.children:
        if isinstance(child, Node) and not ignored(child):
            if tag is None or child.tag == tag:
                yield child
            yield from descendants(child, tag)


def node_text(node: Node) -> str:
    if ignored(node):
        return ""
    parts = [node_text(child) if isinstance(child, Node) else child for child in node.children]
    return re.sub(r"\s+", " ", " ".join(parts)).strip()


def content_blocks(root: Node) -> list[str]:
    tags = {"h1", "h2", "h3", "h4", "h5", "h6", "p", "li", "blockquote", "td", "th"}
    blocks = []
    for node in descendants(root):
        if node.tag in tags or node.tag in ("div", "section", "article") and not any(
            child.tag in tags or child.tag in ("div", "section", "article")
            for child in node.children if isinstance(child, Node)):
            value = node_text(node)
            if value and value not in blocks:
                blocks.append(value[:1000])
    return blocks


def page_content(html: str, kind: str, final_url: str) -> dict:
    if len(html) > MAX_BYTES:
        raise PageError("response_too_large")
    parser = TreeParser()
    parser.feed(html)
    root = next(descendants(parser.root, "main"), None) or next(descendants(parser.root, "body"), parser.root)
    blocks = content_blocks(root)
    text = ("\n".join(blocks) if blocks else node_text(root))[:MAX_TEXT]
    if len(text.strip()) < 10:
        raise PageError("no_extractable_content")
    heading = next(descendants(root, "h1"), None)
    context = (urlsplit(final_url).path + " " + (node_text(heading) if heading else ""))
    result: dict = {"kind": kind, "text": text, "status": "unconfirmed", "reason": "source_type_unverified",
                    "extractor_version": EXTRACTOR_VERSION, "excerpt": text[:500]}
    if kind == "release_notes":
        entries = []
        if not RELEASE_CONTEXT.search(context):
            result.update(entries=entries, reason="release_context_missing")
            return result
        candidate_count = 0
        for article in descendants(root, "article"):
            heading = next((node for node in descendants(article) if node.tag in ("h1", "h2", "h3", "h4")), None)
            if not heading:
                continue
            title = node_text(heading)[:300]
            evidence = node_text(article)[:500]
            marker = article.attrs.get("class", "").lower()
            if any(word in marker for word in ("blog", "news", "insight", "editorial")) or (
                    "author:" in evidence.lower() and "read more" in evidence.lower()):
                continue
            if not title or not RELEASE_EVIDENCE.search(evidence):
                continue
            candidate_count += 1
            date_node = next(descendants(article, "time"), None)
            date = (date_node.attrs.get("datetime") or node_text(date_node))[:80] if date_node else None
            anchor = next((node for node in descendants(article, "a") if node.attrs.get("href")), None)
            if not anchor:
                continue
            link = urljoin(final_url, anchor.attrs["href"])
            try:
                link = canonical_url(link, expected_host=urlsplit(final_url).hostname)
            except PageError:
                continue
            if link == final_url:
                continue
            entries.append({"title": title, "date": date, "url": link, "evidence": evidence})
        result["entries"] = entries[:50]
        result["status"] = "confirmed" if entries and len(entries) == candidate_count else (
            "partial" if entries else "unconfirmed")
        result["reason"] = ("release_entries_confirmed" if result["status"] == "confirmed" else
                            "some_release_entries_unconfirmed" if entries else
                            "release_link_or_title_missing" if candidate_count else "release_entries_missing")
    elif kind == "pricing_page":
        plans = []
        if not PRICING_CONTEXT.search(context):
            result.update(plans=plans, reason="pricing_context_missing")
            return result
        cards = [node for node in descendants(root) if node.tag in ("article", "section", "div") and
                 re.search(r"(^|[\s_-])(plan|pricing|tier)([\s_-]|$)",
                           node.attrs.get("class", "") + " " + node.attrs.get("id", ""), re.IGNORECASE)]
        for card in cards:
            heading = next((node for node in descendants(card) if node.tag in ("h2", "h3", "h4")), None)
            evidence = node_text(card)[:500]
            match = PRICE.search(evidence)
            period_match = PERIOD.search(evidence)
            if not heading:
                continue
            symbol = match.group(1).upper() if match else None
            currency = {"R$": "BRL", "€": "EUR", "£": "GBP"}.get(symbol, symbol) if symbol else None
            period = None
            if period_match:
                period = "year" if re.search(r"year|annual|ano", period_match.group(), re.IGNORECASE) else "month"
            raw_amount = match.group(2).replace(",", ".") if match else None
            try:
                amount = str(Decimal(raw_amount)) if raw_amount else None
            except InvalidOperation:
                amount = None
            name = node_text(heading)[:120]
            remaining = evidence.replace(name, "", 1)
            if match:
                remaining = remaining.replace(match.group(), "", 1)
            if period_match:
                remaining = remaining.replace(period_match.group(), "", 1)
            conditions = re.sub(r"\s+", " ", remaining).strip()
            if name and not any(plan["name"] == name for plan in plans):
                plans.append({"name": name, "amount": amount, "currency": currency,
                              "period": period, "conditions": conditions,
                              "confirmed": amount is not None and currency is not None and period is not None,
                              "evidence": evidence})
        result["plans"] = plans[:30]
        confirmed_count = sum(plan["confirmed"] for plan in plans)
        result["status"] = "confirmed" if plans and confirmed_count == len(plans) else (
            "partial" if confirmed_count else "unconfirmed")
        result["reason"] = ("price_plans_confirmed" if result["status"] == "confirmed" else
                            "some_plans_unconfirmed" if confirmed_count else "price_fields_missing")
    else:
        raise PageError("invalid_source_type")
    return result


def semantic_hash(content: dict) -> str:
    return hashlib.sha256(json.dumps(content, ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest()


def compare_pages(before: dict, after: dict, *, before_trusted: bool = True) -> list[dict]:
    changes = []
    structured = before_trusted and before.get("status") == after.get("status") == "confirmed"
    if structured and before["kind"] == after["kind"] == "pricing_page":
        old_plans = {item["name"]: item for item in before.get("plans", [])}
        new_plans = {item["name"]: item for item in after.get("plans", [])}
        for name in sorted(old_plans.keys() & new_plans.keys()):
            old, new = old_plans[name], new_plans[name]
            if old == new:
                continue
            comparable = (old["confirmed"] and new["confirmed"] and bool(old["conditions"]) and
                          (old["currency"], old["period"], old["conditions"]) ==
                          (new["currency"], new["period"], new["conditions"]))
            percent = None
            if comparable and Decimal(old["amount"]) > 0 and old["amount"] != new["amount"]:
                percent = str(round((Decimal(new["amount"]) / Decimal(old["amount"]) - 1) * 100, 2))
            changes.append({"kind": "price_observed" if comparable else "terms_or_text_changed",
                            "name": name, "previous": old, "current": new, "percent_change": percent})
        for name in sorted(old_plans.keys() ^ new_plans.keys()):
            changes.append({"kind": "plan_appeared" if name in new_plans else "plan_disappeared_from_page",
                            "name": name, "previous": old_plans.get(name), "current": new_plans.get(name),
                            "percent_change": None})
    elif structured and before["kind"] == after["kind"] == "release_notes":
        old_entries = {(item["url"], item["title"]): item for item in before.get("entries", [])}
        new_entries = {(item["url"], item["title"]): item for item in after.get("entries", [])}
        for key in sorted(old_entries.keys() ^ new_entries.keys()):
            changes.append({"kind": "entry_appeared" if key in new_entries else "entry_disappeared_from_page",
                            "previous": old_entries.get(key), "current": new_entries.get(key)})
        for key in sorted(old_entries.keys() & new_entries.keys()):
            if old_entries[key] != new_entries[key]:
                changes.append({"kind": "entry_changed", "previous": old_entries[key],
                                "current": new_entries[key]})
    if before["text"] != after["text"] and not changes:
        old_lines = before["text"].splitlines()
        new_lines = after["text"].splitlines()
        import difflib
        matcher = difflib.SequenceMatcher(a=old_lines, b=new_lines, autojunk=False)
        for action, a0, a1, b0, b1 in matcher.get_opcodes():
            if action != "equal":
                changes.append({"kind": "text_changed_unconfirmed", "previous": " ".join(old_lines[a0:a1])[:500],
                                "current": " ".join(new_lines[b0:b1])[:500]})
                if len(changes) >= 20:
                    break
    return changes


def validate_job(payload: object) -> dict:
    VALIDATOR.validate(payload)
    assert isinstance(payload, dict)
    if payload["idempotency_key"] != f"web-page-{payload['run_id']}-v1":
        raise PageError("invalid_job_key")
    return payload


async def mark_failed(job: dict, error: PageError) -> None:
    async with await psycopg.AsyncConnection.connect(os.environ["RUNTIME_DATABASE_URL"]) as connection:
        await connection.execute("SELECT set_config('app.tenant_id', %s, true)", (job["tenant_id"],))
        updated = await (await connection.execute(
            "UPDATE marketrift.source_runs SET status = 'failed', error_code = %s, "
            "retry_after_at = %s, finished_at = now() WHERE tenant_id = %s AND source_id = %s "
            "AND id = %s AND status = 'running' RETURNING id",
            (error.code, error.retry_at, job["tenant_id"], job["source_id"], job["run_id"]))).fetchone()
        if updated:
            source = await (await connection.execute(
                "SELECT check_interval_minutes, consecutive_failures FROM marketrift.sources "
                "WHERE tenant_id = %s AND id = %s AND monitoring_enabled FOR UPDATE",
                (job["tenant_id"], job["source_id"]))).fetchone()
            if source:
                permanent = error.code in ("access_denied", "robots_disallowed", "robots_unavailable",
                                           "not_found", "unsafe_destination", "no_extractable_content",
                                           "unsupported_content_type", "unsupported_encoding",
                                           "unsupported_charset", "redirect_without_location",
                                           "unsupported_redirect", "redirect_limit")
                delay_seconds = source[0] * 60 if permanent else min(3600, 300 * 2 ** min(source[1], 4))
                await connection.execute(
                    "UPDATE marketrift.sources SET consecutive_failures = consecutive_failures + 1, "
                    "next_check_at = greatest(now() + %s * interval '1 second', "
                    "coalesce(%s::timestamptz, now())) WHERE tenant_id = %s AND id = %s",
                    (delay_seconds, error.retry_at, job["tenant_id"], job["source_id"]))


async def check_web_page(payload: object, fetcher: Callable = fetch_public_page) -> dict:
    job = validate_job(payload)
    async with await psycopg.AsyncConnection.connect(os.environ["RUNTIME_DATABASE_URL"]) as connection:
        await connection.execute("SELECT set_config('app.tenant_id', %s, true)", (job["tenant_id"],))
        source = await (await connection.execute(
            "SELECT s.url, s.source_type, s.last_checked_at, s.monitoring_enabled FROM marketrift.sources s "
            "JOIN marketrift.products p ON p.tenant_id = s.tenant_id AND p.id = s.product_id "
            "WHERE s.tenant_id = %s AND s.id = %s AND s.source_type IN ('pricing_page', 'release_notes') "
            "AND s.enabled = true", (job["tenant_id"], job["source_id"]))).fetchone()
        run = await (await connection.execute(
            "SELECT status, trigger_kind FROM marketrift.source_runs WHERE tenant_id = %s AND source_id = %s "
            "AND id = %s AND run_kind = 'web_page' FOR UPDATE",
            (job["tenant_id"], job["source_id"], job["run_id"]))).fetchone()
        if source is None or run is None:
            raise PageError("source_product_or_run_not_in_tenant")
        if run[0] != "pending":
            return {"status": run[0], "replayed": True}
        if run[1] == "scheduled" and not source[3]:
            await connection.execute(
                "UPDATE marketrift.source_runs SET status = 'failed', error_code = 'monitor_paused', "
                "finished_at = now() WHERE tenant_id = %s AND id = %s",
                (job["tenant_id"], job["run_id"]))
            return {"status": "failed", "error_code": "monitor_paused"}
        await connection.execute("UPDATE marketrift.source_runs SET status = 'running', started_at = now() "
                                 "WHERE tenant_id = %s AND id = %s", (job["tenant_id"], job["run_id"]))
    try:
        final_url, html = await asyncio.to_thread(fetcher, source[0], last_checked_at=source[2])
        content = page_content(html, source[1], final_url)
        digest = semantic_hash(content)
        async with await psycopg.AsyncConnection.connect(os.environ["RUNTIME_DATABASE_URL"]) as connection:
            await connection.execute("SELECT set_config('app.tenant_id', %s, true)", (job["tenant_id"],))
            locked = await (await connection.execute(
                "SELECT status FROM marketrift.source_runs WHERE tenant_id = %s AND source_id = %s "
                "AND id = %s FOR UPDATE", (job["tenant_id"], job["source_id"], job["run_id"]))).fetchone()
            if locked is None or locked[0] != "running":
                raise PageError("run_state_changed")
            previous = await (await connection.execute(
                "SELECT id, version_no, content_sha256, extracted, final_url, normalized_text, "
                "interpretation_version, interpretation_status FROM marketrift.source_snapshots "
                "WHERE tenant_id = %s AND source_id = %s AND extracted IS NOT NULL "
                "ORDER BY version_no DESC LIMIT 1", (job["tenant_id"], job["source_id"]))).fetchone()
            changed = previous is None or previous[5] != content["text"] or previous[4] != final_url
            if changed:
                inserted = await (await connection.execute(
                    "INSERT INTO marketrift.source_snapshots (tenant_id, source_id, run_id, source_url, "
                    "storage_key, content_sha256, version_no, final_url, normalized_text, extracted, "
                    "interpretation_version, interpretation_status, interpretation_reason) "
                    "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb, %s, %s, %s) RETURNING id",
                    (job["tenant_id"], job["source_id"], job["run_id"], source[0],
                     f"db:page-snapshot/{job['run_id']}", digest, (previous[1] + 1) if previous else 1,
                     final_url, content["text"], json.dumps(content, ensure_ascii=False),
                     EXTRACTOR_VERSION, content["status"], content["reason"]))).fetchone()
                if previous:
                    details = compare_pages(previous[3], content,
                                            before_trusted=previous[6] == EXTRACTOR_VERSION and
                                            previous[7] == "confirmed")
                    if previous[4] != final_url:
                        details.append({"kind": "final_url_changed", "previous": previous[4],
                                        "current": final_url})
                    await connection.execute(
                        "INSERT INTO marketrift.page_changes (tenant_id, source_id, previous_snapshot_id, "
                        "current_snapshot_id, change_details) VALUES (%s, %s, %s, %s, %s::jsonb) "
                        "ON CONFLICT DO NOTHING",
                        (job["tenant_id"], job["source_id"], previous[0], inserted[0],
                         json.dumps(details, ensure_ascii=False)))
            await connection.execute(
                "UPDATE marketrift.source_runs SET status = 'succeeded', documents_seen = 1, "
                "documents_new = %s, finished_at = now() WHERE tenant_id = %s AND id = %s",
                (int(changed), job["tenant_id"], job["run_id"]))
            await connection.execute(
                "UPDATE marketrift.sources SET last_checked_at = now(), consecutive_failures = 0, "
                "next_check_at = CASE WHEN monitoring_enabled THEN now() + "
                "check_interval_minutes * interval '1 minute' ELSE NULL END "
                "WHERE tenant_id = %s AND id = %s", (job["tenant_id"], job["source_id"]))
        return {"status": "succeeded", "new_snapshot": changed}
    except PageError as error:
        await mark_failed(job, error)
        return {"status": "failed", "error_code": error.code}
    except Exception:
        await mark_failed(job, PageError("internal_failure"))
        raise
