"""Bounded RSS/Atom metadata ingestion. Never fetches article links or invokes a model."""

import asyncio
import hashlib
import http.client
import json
import os
import re
import socket
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from email.utils import parsedate_to_datetime
from pathlib import Path
from urllib.parse import urljoin, urlsplit
from urllib.robotparser import RobotFileParser
from xml.etree import ElementTree as ET

import psycopg
from jsonschema import Draft202012Validator, FormatChecker

from .source_discovery import DiscoveryError, request_discovery_pinned, request_discovery_pinned_prefix
from .web_pages import USER_AGENT, PageError, canonical_url, resolve_public, retry_after

SCHEMA = json.loads((Path(__file__).resolve().parents[3] /
                     "packages/contracts/sync-feed-job.v1.schema.json").read_text(encoding="utf-8"))
VALIDATOR = Draft202012Validator(SCHEMA, format_checker=FormatChecker())
MAX_ROBOTS = 64_000
MAX_FEED = 512_000
MAX_ENTRIES = 20
MAX_REDIRECTS = 2
ATOM = "{http://www.w3.org/2005/Atom}"


class FeedError(Exception):
    def __init__(self, code: str, retry_at: datetime | None = None):
        super().__init__(code)
        self.code = code
        self.retry_at = retry_at


@dataclass(frozen=True)
class Entry:
    external_id: str
    url: str
    title: str
    date_literal: str | None
    published_at: datetime | None
    content_sha256: str


def _text(node: ET.Element | None) -> str:
    return " ".join("".join(node.itertext()).split()) if node is not None else ""


def _date(value: str | None) -> datetime | None:
    if not value or not re.search(r"\b(?:19|20)\d{2}\b", value):
        return None  # A day/month without a year must stay literal, never inferred.
    try:
        result = datetime.fromisoformat(value)
    except ValueError:
        try:
            result = parsedate_to_datetime(value)
        except (ValueError, TypeError):
            return None
    return result.astimezone(UTC) if result.tzinfo else None


def _entries(nodes: list[ET.Element], atom: bool, feed_url: str, complete: bool) -> tuple[list[Entry], bool]:
    entries: dict[str, Entry] = {}
    for node in nodes[:MAX_ENTRIES]:
        title = _text(node.find(ATOM + "title" if atom else "title"))[:500]
        if atom:
            links = node.findall(ATOM + "link")
            link = next((item.get("href", "") for item in links if item.get("rel", "alternate") == "alternate"), "")
            guid = _text(node.find(ATOM + "id"))
            date_literal = _text(node.find(ATOM + "published")) or _text(node.find(ATOM + "updated"))
            summary = _text(node.find(ATOM + "summary")) or _text(node.find(ATOM + "content"))
        else:
            link = _text(node.find("link"))
            guid = _text(node.find("guid"))
            date_literal = _text(node.find("pubDate"))
            summary = _text(node.find("description"))
        if not title or not link:
            continue
        try:
            url = canonical_url(urljoin(feed_url, link))
        except PageError:
            continue
        external = (guid or url)[:1000]
        digest = hashlib.sha256(json.dumps([title, url, date_literal, summary], ensure_ascii=False).encode()).hexdigest()
        entries[external] = Entry(external, url, title, date_literal or None,
                                   _date(date_literal), digest)
    return list(entries.values()), complete and len(nodes) <= MAX_ENTRIES and len(entries) == len(nodes)


def parse_feed(body: bytes, feed_url: str) -> tuple[list[Entry], bool]:
    if len(body) > MAX_FEED:
        raise FeedError("response_too_large")
    if re.search(rb"<!\s*(?:DOCTYPE|ENTITY)\b", body, re.IGNORECASE):
        raise FeedError("xml_entities_forbidden")
    try:
        root = ET.fromstring(body)
    except ET.ParseError as error:
        raise FeedError("invalid_xml") from error
    if sum(1 for _ in root.iter()) > 3000:
        raise FeedError("xml_structure_limit")
    if root.tag == "rss" and root.get("version", "").startswith("2."):
        channel = root.find("channel")
        if channel is None:
            raise FeedError("invalid_rss")
        nodes = channel.findall("item")
        atom = False
    elif root.tag == ATOM + "feed":
        nodes = root.findall(ATOM + "entry")
        atom = True
    else:
        raise FeedError("unsupported_feed_format")
    return _entries(nodes, atom, feed_url, True)


def parse_feed_prefix(body: bytes, feed_url: str) -> tuple[list[Entry], bool]:
    """Use only closed top-level entries from a bounded XML prefix; never claim full coverage."""
    if len(body) > MAX_FEED:
        raise FeedError("response_too_large")
    if re.search(rb"<!\s*(?:DOCTYPE|ENTITY)\b", body, re.IGNORECASE):
        raise FeedError("xml_entities_forbidden")
    # The transport may stop mid-tag or mid UTF-8 character. Parse only through the
    # last closed entry, then require the normal XML parser to validate that prefix.
    closings = list(re.finditer(rb"</(?:[A-Za-z_][\w.-]*:)?(?:entry|item)\s*>", body))
    if not closings:
        raise FeedError("no_complete_entries_within_limit")
    # The source may contain hundreds of complete entries in the byte window.
    # Inspect only the first MAX_ENTRIES closed items; the rest is unvalidated
    # and the result remains explicitly partial.
    prefix = body[:closings[min(len(closings), MAX_ENTRIES) - 1].end()]
    parser = ET.XMLPullParser(events=("start", "end"))
    try:
        parser.feed(prefix)
        stack: list[str] = []
        nodes: list[ET.Element] = []
        root: str | None = None
        count = 0
        for event, element in parser.read_events():
            count += 1
            if count > 6000:
                raise FeedError("xml_structure_limit")
            if event == "start":
                stack.append(element.tag)
                if root is None:
                    root = element.tag
                    if root == "rss" and not element.get("version", "").startswith("2."):
                        raise FeedError("unsupported_feed_format")
            else:
                if root == ATOM + "feed" and element.tag == ATOM + "entry" and len(stack) == 2:
                    nodes.append(element)
                elif root == "rss" and element.tag == "item" and len(stack) == 3 and stack[1] == "channel":
                    nodes.append(element)
                stack.pop()
    except (ET.ParseError, IndexError) as error:
        raise FeedError("invalid_xml") from error
    if root not in ("rss", ATOM + "feed"):
        raise FeedError("unsupported_feed_format")
    if not nodes:
        raise FeedError("no_complete_entries_within_limit")
    return _entries(nodes, root == ATOM + "feed", feed_url, False)


def fetch_feed(start_url: str, *, etag: str | None = None, modified: str | None = None,
               last_checked_at: datetime | None = None, lookup=socket.getaddrinfo,
               request=request_discovery_pinned, request_prefix=None, before_request=lambda: None
               ) -> tuple[list[Entry], bool, str | None, str | None, bool]:
    """TLS-pinned, DNS-checked requests; redirects stay on the same reviewed host."""
    url = canonical_url(start_url)
    host = urlsplit(url).hostname or ""
    before_request()
    try:
        status, headers, robots = request(f"https://{host}/robots.txt", resolve_public(host, lookup), MAX_ROBOTS)
    except (DiscoveryError, PageError) as error:
        raise FeedError("robots_unavailable", getattr(error, "retry_at", None)) from error
    if status != 404:
        if status != 200:
            raise FeedError("robots_unavailable", retry_after(headers))
        try:
            rules = robots.decode("utf-8-sig")
        except UnicodeDecodeError as error:
            raise FeedError("robots_unavailable") from error
        if "\x00" in rules or not re.search(r"(?im)^\s*user-agent\s*:", rules):
            raise FeedError("robots_unavailable")
        parser = RobotFileParser()
        parser.parse(rules.splitlines())
        if not parser.can_fetch(USER_AGENT, url):
            raise FeedError("robots_disallowed")
        delay = parser.crawl_delay(USER_AGENT)
        if delay and last_checked_at and last_checked_at + timedelta(seconds=delay) > datetime.now(UTC):
            raise FeedError("robots_crawl_delay", last_checked_at + timedelta(seconds=delay))
    conditional = {}
    if etag and len(etag) <= 200 and not re.search(r"[\r\n]", etag):
        conditional["If-None-Match"] = etag
    if modified and len(modified) <= 200 and not re.search(r"[\r\n]", modified):
        conditional["If-Modified-Since"] = modified
    if request_prefix is None:
        request_prefix = (request_discovery_pinned_prefix if request is request_discovery_pinned else
                          lambda target, ip, limit, headers: (*request(target, ip, limit, headers), True))
    for _ in range(MAX_REDIRECTS + 1):
        before_request()
        try:
            status, headers, body, full_body = request_prefix(url, resolve_public(host, lookup), MAX_FEED, conditional)
        except DiscoveryError as error:
            raise FeedError(error.code, error.retry_at) from error
        except PageError as error:
            raise FeedError(error.code, error.retry_at) from error
        if status in (301, 302, 307, 308):
            location = headers.get("location")
            if not location:
                raise FeedError("redirect_without_location")
            try:
                url = canonical_url(urljoin(url, location), expected_host=host)
            except PageError as error:
                raise FeedError("unsafe_redirect") from error
            conditional = {}  # Do not send validators for a different resource.
            continue
        if status == 304:
            return [], True, etag, modified, True
        if status in (429, 503):
            raise FeedError("rate_limited", retry_after(headers) or datetime.now(UTC) + timedelta(minutes=5))
        if status in (401, 403):
            raise FeedError("access_denied")
        if status != 200:
            raise FeedError("http_failure")
        if headers.get("content-encoding", "identity").lower() not in ("identity", ""):
            raise FeedError("unsupported_encoding")
        if not any(token in headers.get("content-type", "").lower() for token in
                   ("xml", "rss", "atom")):
            raise FeedError("unsupported_content_type")
        entries, complete = (parse_feed(body, url) if full_body else parse_feed_prefix(body, url))
        return (entries, complete, headers.get("etag", "")[:200] or None,
                headers.get("last-modified", "")[:200] or None, False)
    raise FeedError("redirect_limit")


def _test_request(url: str, _ip: str, limit: int, headers: dict[str, str] | None = None):
    base = urlsplit(os.environ["FEED_TEST_BASE_URL"])
    if os.getenv("MARKETRIFT_TEST_MODE") != "1" or base.hostname != "127.0.0.1" or not base.port:
        raise FeedError("test_transport_disabled")
    if urlsplit(url).hostname != "example.com":
        raise FeedError("invalid_test_host")
    connection = http.client.HTTPConnection("127.0.0.1", base.port, timeout=5)
    try:
        connection.request("GET", "/feed" + urlsplit(url).path, headers=headers or {})
        response = connection.getresponse()
        if response.length is not None and response.length > limit:
            raise DiscoveryError("response_too_large")
        body = response.read(limit + 1)
        if len(body) > limit:
            raise DiscoveryError("response_too_large")
        return response.status, {k.lower(): v for k, v in response.getheaders()}, body
    finally:
        connection.close()


def _test_request_prefix(url: str, _ip: str, limit: int, headers: dict[str, str] | None = None):
    """Controlled container transport with the same bounded-prefix contract."""
    base = urlsplit(os.environ["FEED_TEST_BASE_URL"])
    if os.getenv("MARKETRIFT_TEST_MODE") != "1" or base.hostname != "127.0.0.1" or not base.port:
        raise FeedError("test_transport_disabled")
    if urlsplit(url).hostname != "example.com":
        raise FeedError("invalid_test_host")
    connection = http.client.HTTPConnection("127.0.0.1", base.port, timeout=5)
    try:
        connection.request("GET", "/feed" + urlsplit(url).path, headers=headers or {})
        response = connection.getresponse()
        declared_length = response.length
        body = response.read(limit + 1)
        if declared_length is not None and len(body) < declared_length and len(body) <= limit:
            raise FeedError("response_truncated")
        return response.status, {k.lower(): v for k, v in response.getheaders()}, body[:limit], len(body) <= limit
    finally:
        connection.close()


def _check_state(job: dict, expected_url: str, *, running: bool) -> None:
    with psycopg.connect(os.environ["RUNTIME_DATABASE_URL"]) as conn:
        conn.execute("SELECT set_config('app.tenant_id',%s,true)", (job["tenant_id"],))
        row = conn.execute("SELECT s.url,s.enabled,s.monitoring_enabled,s.feed_monitor_generation,"
                           "r.status,r.trigger_kind,r.feed_monitor_generation "
                           "FROM marketrift.source_runs r JOIN marketrift.sources s "
                           "ON s.tenant_id=r.tenant_id AND s.id=r.source_id "
                           "JOIN marketrift.products p ON p.tenant_id=s.tenant_id AND p.id=s.product_id "
                           "WHERE r.tenant_id=%s AND r.id=%s AND r.source_id=%s AND s.source_type='rss_feed'",
                           (job["tenant_id"], job["run_id"], job["source_id"])).fetchone()
        if not row or row[0] != expected_url or not row[1] or not row[2] or row[4] != ("running" if running else "pending"):
            raise FeedError("source_changed")
        if row[6] is not None and (row[3] != row[6] or row[6] != job.get("monitor_generation")):
            raise FeedError("monitoring_changed")
        if row[5] == "scheduled" and row[6] is None:
            raise FeedError("monitoring_changed")
        if row[5] == "manual" and row[6] is None and job.get("monitor_generation") is not None:
            raise FeedError("invalid_monitor_generation")


async def sync_feed(payload: object, fetcher=fetch_feed) -> dict:
    VALIDATOR.validate(payload)
    assert isinstance(payload, dict)
    job = payload
    if job["idempotency_key"] != f"feed-{job['run_id']}-v1":
        raise FeedError("invalid_job_key")
    async with await psycopg.AsyncConnection.connect(os.environ["RUNTIME_DATABASE_URL"]) as conn:
        await conn.execute("SELECT set_config('app.tenant_id',%s,true)", (job["tenant_id"],))
        row = await (await conn.execute("SELECT s.url,s.feed_etag,s.feed_last_modified,s.last_checked_at,r.status,"
            "(SELECT previous.scan_complete FROM marketrift.source_runs previous "
            "WHERE previous.tenant_id=s.tenant_id AND previous.source_id=s.id "
            "AND previous.run_kind='feed' AND previous.status='succeeded' "
            "ORDER BY previous.finished_at DESC,previous.id DESC LIMIT 1) "
            "FROM marketrift.source_runs r JOIN marketrift.sources s ON s.tenant_id=r.tenant_id AND s.id=r.source_id "
            "JOIN marketrift.products p ON p.tenant_id=s.tenant_id AND p.id=s.product_id "
            "WHERE r.tenant_id=%s AND r.id=%s AND r.source_id=%s AND r.run_kind='feed' "
            "AND s.source_type='rss_feed' AND s.enabled FOR UPDATE OF r,s",
            (job["tenant_id"],job["run_id"],job["source_id"]))).fetchone()
        if row is None:
            raise FeedError("source_not_found")
        if row[4] != "pending":
            return {"status": row[4], "replayed": True}
        url, etag, modified, checked, _, previous_complete = row
        # Scheduled jobs must also match the current source revision before network access.
        await conn.commit()
    try:
        await asyncio.to_thread(_check_state, job, url, running=False)
        async with await psycopg.AsyncConnection.connect(os.environ["RUNTIME_DATABASE_URL"]) as conn:
            await conn.execute("SELECT set_config('app.tenant_id',%s,true)", (job["tenant_id"],))
            await conn.execute("UPDATE marketrift.source_runs SET status='running' WHERE tenant_id=%s AND id=%s AND status='pending'",
                               (job["tenant_id"], job["run_id"]))
        options = {}
        if os.getenv("MARKETRIFT_TEST_MODE") == "1" and os.getenv("FEED_TEST_BASE_URL"):
            options = {"lookup": lambda *_args, **_kwargs: [(socket.AF_INET,socket.SOCK_STREAM,6,"",("93.184.215.14",443))],
                       "request": _test_request, "request_prefix": _test_request_prefix}
        entries, complete, new_etag, new_modified, unchanged = await asyncio.to_thread(
            fetcher, url, etag=etag, modified=modified, last_checked_at=checked,
            before_request=lambda: _check_state(job, url, running=True), **options)
        if unchanged and previous_complete is False:
            complete = False
        new_count = updated_count = 0
        async with await psycopg.AsyncConnection.connect(os.environ["RUNTIME_DATABASE_URL"]) as conn:
            await conn.execute("SELECT set_config('app.tenant_id',%s,true)", (job["tenant_id"],))
            locked = await (await conn.execute("SELECT s.feed_monitor_generation,s.monitoring_enabled,r.status,"
                "r.trigger_kind,r.feed_monitor_generation FROM marketrift.sources s JOIN marketrift.products p "
                "ON p.tenant_id=s.tenant_id AND p.id=s.product_id JOIN marketrift.source_runs r "
                "ON r.tenant_id=s.tenant_id AND r.source_id=s.id WHERE s.tenant_id=%s AND s.id=%s "
                "AND r.id=%s AND s.source_type='rss_feed' AND s.url=%s AND s.enabled FOR UPDATE OF s,r",
                (job["tenant_id"],job["source_id"],job["run_id"],url))).fetchone()
            if not locked or not locked[1] or locked[2] != "running" or (locked[4] is not None and
                (locked[0] != locked[4] or locked[4] != job.get("monitor_generation"))) or (locked[3] == "scheduled"
                and locked[4] is None):
                raise FeedError("run_state_changed")
            if not unchanged:
                for item in entries:
                    previous = await (await conn.execute("SELECT id,content_sha256,version_no FROM marketrift.feed_entries "
                        "WHERE tenant_id=%s AND source_id=%s AND external_id=%s FOR UPDATE",
                        (job["tenant_id"],job["source_id"],item.external_id))).fetchone()
                    if previous is None:
                        inserted = await (await conn.execute("INSERT INTO marketrift.feed_entries "
                            "(tenant_id,source_id,external_id,canonical_url,title,date_literal,published_at,content_sha256) "
                            "VALUES (%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING RETURNING id",
                            (job["tenant_id"],job["source_id"],item.external_id,item.url,item.title,
                             item.date_literal,item.published_at,item.content_sha256))).fetchone()
                        if inserted:
                            new_count += 1
                            await conn.execute("INSERT INTO marketrift.feed_entry_versions "
                                "(tenant_id,entry_id,version_no,canonical_url,title,date_literal,published_at,content_sha256) "
                                "VALUES (%s,%s,1,%s,%s,%s,%s,%s)",
                                (job["tenant_id"],inserted[0],item.url,item.title,item.date_literal,
                                 item.published_at,item.content_sha256))
                    elif previous[1] != item.content_sha256:
                        version = previous[2] + 1
                        await conn.execute("UPDATE marketrift.feed_entries SET canonical_url=%s,title=%s,"
                            "date_literal=%s,published_at=%s,content_sha256=%s,version_no=%s,"
                            "last_seen_at=now(),updated_at=now() WHERE tenant_id=%s AND id=%s",
                            (item.url,item.title,item.date_literal,item.published_at,item.content_sha256,
                             version,job["tenant_id"],previous[0]))
                        await conn.execute("INSERT INTO marketrift.feed_entry_versions "
                            "(tenant_id,entry_id,version_no,canonical_url,title,date_literal,published_at,content_sha256) "
                            "VALUES (%s,%s,%s,%s,%s,%s,%s,%s)",
                            (job["tenant_id"],previous[0],version,item.url,item.title,item.date_literal,
                             item.published_at,item.content_sha256))
                        updated_count += 1
                    else:
                        await conn.execute("UPDATE marketrift.feed_entries SET last_seen_at=now() "
                                           "WHERE tenant_id=%s AND id=%s", (job["tenant_id"],previous[0]))
            await conn.execute("UPDATE marketrift.sources SET last_checked_at=now(),feed_etag=%s,"
                               "feed_last_modified=%s WHERE tenant_id=%s AND id=%s",
                               (new_etag,new_modified,job["tenant_id"],job["source_id"]))
            await conn.execute("UPDATE marketrift.source_runs SET status='succeeded',scan_complete=%s,"
                               "documents_seen=%s,documents_new=%s,documents_updated=%s,pages_fetched=%s,"
                               "finished_at=now() WHERE tenant_id=%s AND id=%s",
                               (complete,len(entries),new_count,updated_count,1,job["tenant_id"],job["run_id"]))
        return {"status": "succeeded", "seen": len(entries), "new": new_count,
                "updated": updated_count, "scan_complete": complete, "not_modified": unchanged}
    except FeedError as error:
        async with await psycopg.AsyncConnection.connect(os.environ["RUNTIME_DATABASE_URL"]) as conn:
            await conn.execute("SELECT set_config('app.tenant_id',%s,true)", (job["tenant_id"],))
            cancellation = error.code in {"source_changed", "monitoring_changed", "run_state_changed"}
            await conn.execute("UPDATE marketrift.source_runs SET status=%s,error_code=%s,"
                               "retry_after_at=%s,finished_at=now() WHERE tenant_id=%s AND id=%s "
                               "AND status IN ('pending','running')",
                               ("cancelled" if cancellation else "failed",error.code,error.retry_at,
                                job["tenant_id"],job["run_id"]))
            state = await (await conn.execute("SELECT status,error_code FROM marketrift.source_runs "
                "WHERE tenant_id=%s AND id=%s", (job["tenant_id"],job["run_id"]))).fetchone()
        return {"status": state[0] if state else "failed",
                "error_code": state[1] if state else error.code}
    except Exception:
        async with await psycopg.AsyncConnection.connect(os.environ["RUNTIME_DATABASE_URL"]) as conn:
            await conn.execute("SELECT set_config('app.tenant_id',%s,true)", (job["tenant_id"],))
            await conn.execute("UPDATE marketrift.source_runs SET status='failed',error_code='internal_failure',"
                               "finished_at=now() WHERE tenant_id=%s AND id=%s AND status IN ('pending','running')",
                               (job["tenant_id"],job["run_id"]))
        raise
