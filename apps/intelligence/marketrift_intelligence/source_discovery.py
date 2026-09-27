"""Limited source discovery from an explicitly registered public HTTPS domain."""

import asyncio
import http.client
import json
import os
import re
import socket
import ssl
import time
from dataclasses import dataclass
from datetime import datetime
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urljoin, urlsplit, urlunsplit
from urllib.robotparser import RobotFileParser
from xml.etree import ElementTree

import psycopg
from jsonschema import Draft202012Validator, FormatChecker

from .web_pages import USER_AGENT, PageError, canonical_url, resolve_public, retry_after

SCHEMA = json.loads((Path(__file__).resolve().parents[3] /
                     "packages/contracts/discover-sources-job.v1.schema.json").read_text(encoding="utf-8"))
VALIDATOR = Draft202012Validator(SCHEMA, format_checker=FormatChecker())
MAX_REQUESTS = 7  # robots, homepage, at most two sitemaps, two feeds and one relevant page
MAX_CANDIDATES = 60
MAX_RESPONSE_BYTES = 1_000_000
MAX_ROBOTS_BYTES = 256_000
MAX_RESOURCE_SECONDS = 8
MAX_SEARCH_QUERIES = 3
MAX_SEARCH_RESULTS_PER_QUERY = 5
MAX_SEARCH_RESPONSE_BYTES = 256_000
CLASSIFICATION_VERSION = 2
BRAVE_SEARCH_URL = "https://api.search.brave.com/res/v1/web/search"
RELEVANT = re.compile(r"pricing|price|plans?|pre[cç]os?|changelog|release|updates?|docs?|blog|status|support|help|forum|community|github|discord|reddit|g2|reclame|instagram|linkedin|youtube|app\s?store|play\s?store|rss|atom|feed", re.IGNORECASE)


@dataclass(frozen=True)
class Candidate:
    url: str
    category: str
    suggested_type: str
    from_url: str
    method: str
    evidence: str
    confidence: str
    search_provider: str | None = None
    search_query: str | None = None


class DiscoveryError(Exception):
    def __init__(self, code: str, retry_at: datetime | None = None, *, resource: str | None = None,
                 url: str | None = None, limit_kind: str | None = None, attempted: int = 0):
        super().__init__(code)
        self.code = code
        self.retry_at = retry_at
        self.resource = resource
        self.url = url
        self.limit_kind = limit_kind
        self.attempted = attempted


def request_discovery_pinned(url: str, ip: str, limit: int = MAX_RESPONSE_BYTES) -> tuple[int, dict[str, str], bytes]:
    """Read bounded chunks over TLS to the DNS-checked IP; never buffer an oversized response."""
    parts = urlsplit(url)
    host = parts.hostname or ""
    connection = http.client.HTTPSConnection(host, 443, timeout=MAX_RESOURCE_SECONDS,
                                             context=ssl.create_default_context())
    deadline = time.monotonic() + MAX_RESOURCE_SECONDS

    def connect_checked(_address, _timeout, source_address=None):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise DiscoveryError("resource_timeout")
        return socket.create_connection((ip, 443), min(_timeout, remaining), source_address)

    connection._create_connection = connect_checked
    try:
        connection.connect()
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise DiscoveryError("resource_timeout")
        if connection.sock is not None:
            connection.sock.settimeout(remaining)
        connection.request("GET", parts.path, headers={"Host": host, "User-Agent": USER_AGENT,
                           "Accept": "text/html, application/xml, application/rss+xml, text/xml;q=0.8",
                           "Accept-Encoding": "identity", "Connection": "close"})
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise DiscoveryError("resource_timeout")
        if connection.sock is not None:
            connection.sock.settimeout(remaining)
        response = connection.getresponse()
        headers = {key.lower(): value for key, value in response.getheaders()}
        if response.status != 200:
            return response.status, headers, b""
        declared_length = response.length
        if declared_length is not None and declared_length > limit:
            raise DiscoveryError("response_too_large", limit_kind="content_length")
        chunks: list[bytes] = []
        size = 0
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise DiscoveryError("resource_timeout")
            if connection.sock is not None:
                connection.sock.settimeout(remaining)
            chunk = response.read(min(65_536, limit + 1 - size))
            if not chunk:
                break
            size += len(chunk)
            if size > limit:
                raise DiscoveryError("response_too_large", limit_kind="actual_bytes")
            chunks.append(chunk)
        if declared_length is not None and size < declared_length:
            raise DiscoveryError("response_truncated")
        return response.status, headers, b"".join(chunks)
    except TimeoutError as error:
        raise DiscoveryError("resource_timeout") from error
    except (OSError, ssl.SSLError, http.client.HTTPException) as error:
        raise DiscoveryError("network_failure") from error
    finally:
        connection.close()


def candidate_priority(item: Candidate) -> int:
    """Selection priority only; a high rank never verifies a source or its rights."""
    return {"pricing_page": 100, "release_notes": 95, "g2": 90, "reclameaqui": 85,
            "app_store": 80, "github_repository": 75, "community": 70, "support": 65,
            "social_profile": 60, "status_page": 45, "homepage": 40,
            "changelog_entry": 60, "product_mention": 35,
            "blog_or_feed": 30, "external_mention": 25, "documentation": 10}.get(item.suggested_type, 20)


def prioritized_candidates(items: list[Candidate], limit: int = MAX_CANDIDATES) -> list[Candidate]:
    """Keep useful source types when a sitemap contains many documentation entries."""
    return sorted(items, key=lambda item: (-candidate_priority(item), item.url))[:limit]


def brave_request(query: str, token: str) -> tuple[int, dict[str, str], bytes]:
    """Fixed official API host; bounded JSON read, no redirects or credential logging."""
    target = "/res/v1/web/search?" + urlencode({"q": query, "count": MAX_SEARCH_RESULTS_PER_QUERY,
                                                 "result_filter": "web", "safesearch": "moderate"})
    connection = http.client.HTTPSConnection("api.search.brave.com", 443, timeout=MAX_RESOURCE_SECONDS,
                                             context=ssl.create_default_context())
    deadline = time.monotonic() + MAX_RESOURCE_SECONDS
    try:
        connection.request("GET", target, headers={"X-Subscription-Token": token,
                           "Accept": "application/json", "Accept-Encoding": "identity"})
        response = connection.getresponse()
        headers = {key.lower(): value for key, value in response.getheaders()}
        if response.status != 200:
            return response.status, headers, b""
        if response.length is not None and response.length > MAX_SEARCH_RESPONSE_BYTES:
            raise DiscoveryError("search_response_too_large")
        chunks: list[bytes] = []
        size = 0
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise DiscoveryError("search_timeout")
            if connection.sock is not None:
                connection.sock.settimeout(remaining)
            chunk = response.read(min(65_536, MAX_SEARCH_RESPONSE_BYTES + 1 - size))
            if not chunk:
                break
            size += len(chunk)
            if size > MAX_SEARCH_RESPONSE_BYTES:
                raise DiscoveryError("search_response_too_large")
            chunks.append(chunk)
        if response.length is not None and size < response.length:
            raise DiscoveryError("search_response_truncated")
        return response.status, headers, b"".join(chunks)
    except TimeoutError as error:
        raise DiscoveryError("search_timeout") from error
    except (OSError, ssl.SSLError, http.client.HTTPException) as error:
        raise DiscoveryError("search_network_failure") from error
    finally:
        connection.close()


def search_queries(name: str, aliases: list[str], domain: str) -> list[str]:
    label = name.split("—", 1)[0].strip()
    brand = next((alias for alias in aliases if 2 <= len(alias.strip()) <= 60), "") \
        or (label if 2 <= len(label) <= 60 else domain.split(".")[0])
    brand = re.sub(r"[\r\n\"\\]", " ", brand).strip()[:60]
    return [f'"{brand}" software reviews G2 Capterra',
            f'"{brand}" community forum GitHub Reddit',
            f'"{domain}" app marketplace news']


def search_external(name: str, aliases: list[str], domain: str, *,
                    request=brave_request, token: str | None = None,
                    storage_rights: bool = False) -> tuple[list[Candidate], str, int, datetime | None]:
    """Search only after an explicit run request and verified provider storage rights."""
    if not token:
        return [], "not_configured", 0, None
    if not storage_rights:
        return [], "storage_rights_unconfirmed", 0, None
    candidates: dict[str, Candidate] = {}
    count = 0
    try:
        for query in search_queries(name, aliases, domain)[:MAX_SEARCH_QUERIES]:
            count += 1
            status, headers, body = request(query, token)
            if status == 401:
                return list(candidates.values()), "invalid_credential", count, None
            if status == 403:
                return list(candidates.values()), "access_denied", count, None
            if status == 429:
                return list(candidates.values()), "rate_limited", count, retry_after(headers)
            if status != 200:
                return list(candidates.values()), "search_http_failure", count, None
            if "json" not in headers.get("content-type", "application/json").lower():
                return list(candidates.values()), "search_invalid_response", count, None
            data = json.loads(body)
            results = data.get("web", {}).get("results", [])
            if not isinstance(results, list):
                return list(candidates.values()), "search_invalid_response", count, None
            for result in results[:MAX_SEARCH_RESULTS_PER_QUERY]:
                if not isinstance(result, dict):
                    continue
                raw_url = str(result.get("url", ""))
                if not raw_url.startswith("https://"):
                    continue
                url = safe_link(BRAVE_SEARCH_URL, raw_url)
                if not url:
                    continue
                title = str(result.get("title", ""))[:160].strip()
                identity = classify(url, title, domain, from_url=BRAVE_SEARCH_URL,
                                    method="web_search") or ("other", "external_mention", "ambiguous")
                category, suggested, _ = identity
                # Search ranking does not establish identity, rights or customer status.
                candidates.setdefault(url, Candidate(url, category, suggested, BRAVE_SEARCH_URL,
                                     "web_search", title or "Resultado de busca; associação a verificar",
                                     "ambiguous", "brave", query))
    except DiscoveryError as error:
        return list(candidates.values()), error.code, count, error.retry_at
    except (ValueError, TypeError, KeyError, AttributeError):
        return list(candidates.values()), "search_invalid_response", count, None
    return list(candidates.values()), "completed", count, None


class Links(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.links: list[tuple[str, str, str]] = []
        self.current: tuple[str, str] | None = None

    def handle_starttag(self, tag, attrs):
        attributes = dict(attrs)
        if tag == "a" and attributes.get("href"):
            self.current = (attributes["href"], "")
        elif tag == "link" and attributes.get("href") and "alternate" in attributes.get("rel", ""):
            self.links.append((attributes["href"], attributes.get("title", "feed"), "feed"))

    def handle_data(self, data):
        if self.current:
            self.current = (self.current[0], (self.current[1] + data)[:160])

    def handle_endtag(self, tag):
        if tag == "a" and self.current:
            self.links.append((self.current[0], self.current[1].strip(), "homepage"))
            self.current = None


def classify(url: str, label: str, official_host: str, *, from_url: str = "",
             method: str = "homepage") -> tuple[str, str, str] | None:
    parsed = urlsplit(url)
    host = parsed.hostname or ""
    clue = f"{parsed.path} {label} {host}".lower()
    confidence = "official_host" if host == official_host else "linked_external"
    def is_host(expected: str) -> bool:
        return host == expected or host.endswith("." + expected)

    if is_host("instagram.com") or is_host("linkedin.com") or is_host("youtube.com"):
        return "social", "social_profile", confidence
    if is_host("g2.com"):
        return "reviews", "g2", "ambiguous"
    if is_host("reclameaqui.com.br"):
        return "reviews", "reclameaqui", "ambiguous"
    if is_host("apps.apple.com") or is_host("play.google.com"):
        return "apps", "app_store", confidence
    if is_host("github.com"):
        return "community", "github_repository", confidence
    if is_host("reddit.com") or is_host("discord.gg") or is_host("discord.com"):
        return "community", "community", "ambiguous"
    path = parsed.path.lower().rstrip("/") or "/"
    source = urlsplit(from_url)
    source_path = source.path.lower().rstrip("/")
    if re.search(r"(?:^|/)(?:docs?|documentation)(?:/|$)", path):
        return "product", "documentation", confidence
    if re.search(r"(?:^|/)(?:blog|news|articles?)(?:/|$)", path):
        return "news", "blog_or_feed", confidence
    # The relation to a read index is stronger than price words in an anchor.
    if (source.hostname == host and source_path and
            re.search(r"(?:^|/)(?:changelog|release-notes|releases)$", source_path) and
            path.startswith(source_path + "/") and method == "homepage"):
        return "product", "changelog_entry", confidence
    # A changelog child also remains an entry when found only in a sitemap.
    changelog_path = re.search(r"(?:^|/)(?:changelog|release-notes|releases)(?:/|$)", path)
    if changelog_path:
        return ("product", "changelog_entry" if path[changelog_path.end():]
                else "release_notes", confidence)
    if re.search(r"(?:^|/)(?:pricing|prices|plans?|precos)$", path):
        return "product", "pricing_page", confidence if host == official_host else "ambiguous"
    if path.endswith((".rss", ".atom", ".xml")) or re.search(r"(?:^|/)(?:rss|atom|feed)(?:/|$)", path):
        return "news", "blog_or_feed", confidence
    if re.search(r"(?:^|/)status(?:/|$)", path):
        return "official_site", "status_page", confidence
    if re.search(r"(?:^|/)(?:docs?|documentation)(?:/|$)", parsed.path.lower()):
        return "product", "documentation", confidence
    if re.search(r"\b(?:pricing|prices?|pre[cç]os?|plans?)\b", clue):
        return "product", "product_mention", confidence if host == official_host else "ambiguous"
    if re.search(r"changelog|release|version|updates?", clue):
        return "product", "product_mention", confidence if host == official_host else "ambiguous"
    if re.search(r"docs?|documentation", clue):
        return "product", "documentation", confidence
    if re.search(r"support|help|forum|community", clue):
        return "community", "support", confidence
    if re.search(r"blog|news|rss|atom|feed", clue):
        return "news", "blog_or_feed", confidence
    return None


def safe_link(base: str, href: str) -> str | None:
    try:
        parsed = urlsplit(urljoin(base, href))
        if parsed.query and any(not (key.lower().startswith("utm_") or key.lower() in
                                     {"fbclid", "gclid"}) for key, _ in parse_qsl(parsed.query,
                                                                                   keep_blank_values=True)):
            return None
        path = parsed.path.rstrip("/") or "/"
        return canonical_url(urlunsplit((parsed.scheme, parsed.netloc, path, "", "")))
    except (PageError, ValueError):
        return None


def validate_job(payload: object) -> dict:
    VALIDATOR.validate(payload)
    assert isinstance(payload, dict)
    if payload["idempotency_key"] != f"source-discovery-{payload['run_id']}-v1":
        raise DiscoveryError("invalid_job_key")
    return payload


def collect(domain: str, official_urls: list[str], *, lookup=socket.getaddrinfo,
            request=request_discovery_pinned) -> tuple[list[Candidate], int, list[dict[str, str]]]:
    """Fetch at most seven same-host resources. External URLs are never fetched."""
    home = canonical_url(f"https://{domain}/", expected_host=domain)
    checked = 0
    resolve_public(domain, lookup)
    last_request = 0.0
    crawl_delay = 0
    failures: list[dict[str, str]] = []

    def fetch(url: str, resource: str, robots: RobotFileParser | None = None,
              limit: int = MAX_RESPONSE_BYTES) -> tuple[str, dict[str, str], bytes]:
        nonlocal checked, last_request
        for _ in range(3):
            if checked >= MAX_REQUESTS:
                raise DiscoveryError("request_limit", resource=resource, attempted=checked)
            url = canonical_url(url, expected_host=domain)
            if robots and not robots.can_fetch("MarketRiftPublicPageMonitor/1.0", url):
                raise DiscoveryError("robots_disallowed", resource=resource, attempted=checked)
            remaining = crawl_delay - (time.monotonic() - last_request)
            if remaining > 0:
                time.sleep(remaining)
            checked += 1
            try:
                ip = resolve_public(domain, lookup)
                if request is request_discovery_pinned:
                    status, headers, body = request(url, ip, limit)
                else:
                    status, headers, body = request(url, ip)
            except (DiscoveryError, PageError) as error:
                raise DiscoveryError(error.code, getattr(error, "retry_at", None), resource=resource,
                                     url=url, limit_kind=getattr(error, "limit_kind", None), attempted=checked) from error
            except (OSError, http.client.HTTPException) as error:
                raise DiscoveryError("network_failure", resource=resource, url=url, attempted=checked) from error
            finally:
                last_request = time.monotonic()
            if status in (301, 302, 307, 308):
                target = headers.get("location", "")
                try:
                    url = canonical_url(urljoin(url, target), expected_host=domain)
                except PageError as error:
                    raise DiscoveryError(error.code, resource=resource, url=url,
                                         attempted=checked) from error
                continue
            if status in (401, 403):
                raise DiscoveryError("access_denied", resource=resource, url=url, attempted=checked)
            if status in (429, 503):
                raise DiscoveryError("rate_limited", retry_after(headers), resource=resource,
                                     url=url, attempted=checked)
            if status == 404:
                raise DiscoveryError("not_found", resource=resource, url=url, attempted=checked)
            if status != 200:
                raise DiscoveryError("http_failure", resource=resource, url=url, attempted=checked)
            if headers.get("content-encoding", "identity").lower() not in ("identity", ""):
                raise DiscoveryError("unsupported_encoding", resource=resource, url=url, attempted=checked)
            if headers.get("content-length", "").isdigit() and int(headers["content-length"]) > limit:
                raise DiscoveryError("response_too_large", resource=resource, url=url,
                                     limit_kind="content_length", attempted=checked)
            if len(body) > limit:
                raise DiscoveryError("response_too_large", resource=resource, url=url,
                                     limit_kind="actual_bytes", attempted=checked)
            return url, headers, body
        raise DiscoveryError("redirect_limit", resource=resource, url=url, attempted=checked)

    try:
        _, _headers, robots_body = fetch(f"https://{domain}/robots.txt", "robots.txt",
                                         limit=MAX_ROBOTS_BYTES)
        status = 200
    except DiscoveryError as error:
        if error.code != "not_found":
            if error.code == "response_too_large":
                raise DiscoveryError("robots_too_large", resource="robots.txt",
                                     url=error.url, limit_kind=error.limit_kind, attempted=checked) from error
            raise DiscoveryError("robots_unavailable", error.retry_at, resource="robots.txt",
                                 url=error.url, attempted=checked) from error
        status, _headers, robots_body = 404, {}, b""
    robots = RobotFileParser()
    sitemap_urls = [f"https://{domain}/sitemap.xml"]
    if status == 200:
        try:
            robots_text = robots_body.decode("utf-8-sig")
        except UnicodeDecodeError as error:
            raise DiscoveryError("robots_invalid", resource="robots.txt", url=f"https://{domain}/robots.txt",
                                 attempted=checked) from error
        if ("\x00" in robots_text or not re.search(r"(?im)^\s*user-agent\s*:", robots_text)
                or any(len(line) > 4096 for line in robots_text.splitlines())):
            raise DiscoveryError("robots_invalid", resource="robots.txt", url=f"https://{domain}/robots.txt",
                                 attempted=checked)
        robots.parse(robots_text.splitlines())
        for line in robots_text.splitlines():
            if line.lower().startswith("sitemap:"):
                url = safe_link(home, line.split(":", 1)[1].strip())
                if url and urlsplit(url).hostname == domain and url not in sitemap_urls:
                    sitemap_urls.append(url)
        delay = robots.crawl_delay("MarketRiftPublicPageMonitor/1.0")
        if delay and delay > 5:
            raise DiscoveryError("robots_crawl_delay", resource="robots.txt",
                                 url=f"https://{domain}/robots.txt", attempted=checked)
        crawl_delay = delay or 0
    else:
        robots.parse([])

    candidates: dict[str, Candidate] = {}

    def add(url: str, label: str, from_url: str, method: str, *, unverified: bool = False):
        canonical = safe_link(from_url, url)
        if not canonical:
            return
        identity = (("official_site", "homepage", "official_host") if canonical == home
                    else classify(canonical, label, domain, from_url=from_url, method=method))
        if identity is None:
            return
        category, suggested, confidence = identity
        if unverified:
            confidence = "ambiguous"
        item = Candidate(canonical, category, suggested, from_url, method,
                         (label or "URL listed by official site")[:160], confidence)
        existing = candidates.get(canonical)
        if existing is None or existing.confidence == "ambiguous" and confidence == "official_host":
            candidates[canonical] = item

    for value in official_urls:
        add(value, "URL provided by tenant, not independently verified", home, "known_url", unverified=True)

    parser = Links()
    feeds: list[str] = []
    relevant_internal: list[str] = []
    try:
        final_home, headers, body = fetch(home, "homepage", robots)
        if not headers.get("content-type", "").lower().startswith("text/html"):
            raise DiscoveryError("unsupported_content_type", resource="homepage", attempted=checked)
        parser.feed(body.decode("utf-8", errors="replace"))
        add(home, "Official homepage", final_home, "homepage")
        if len(parser.links) > 1000:
            failures.append({"resource": "homepage", "url": final_home,
                             "code": "link_limit", "limit_kind": ""})
        for href, label, method in parser.links[:1000]:
            url = safe_link(final_home, href)
            if not url:
                continue
            add(url, label, final_home, method)
            if method == "feed" and urlsplit(url).hostname == domain:
                feeds.append(url)
            elif urlsplit(url).hostname == domain and RELEVANT.search(f"{url} {label}"):
                relevant_internal.append(url)
    except DiscoveryError as error:
        if error.code in ("rate_limited", "robots_disallowed", "unsafe_destination", "request_limit"):
            raise
        failures.append({"resource": "homepage", "url": home, "code": error.code,
                         "limit_kind": error.limit_kind or ""})

    for sitemap in sitemap_urls[:2]:
        if checked >= MAX_REQUESTS:
            break
        try:
            final, headers, body = fetch(sitemap, "sitemap", robots)
        except DiscoveryError as error:
            if error.code in ("not_found", "robots_disallowed"):
                continue
            if error.code in ("rate_limited", "unsafe_destination", "request_limit"):
                raise
            failures.append({"resource": "sitemap", "url": sitemap, "code": error.code,
                             "limit_kind": error.limit_kind or ""})
            continue
        if not ("xml" in headers.get("content-type", "").lower() or body.lstrip().startswith(b"<?xml")):
            failures.append({"resource": "sitemap", "url": sitemap, "code": "unsupported_content_type",
                             "limit_kind": ""})
            continue
        if b"<!DOCTYPE" in body.upper() or b"<!ENTITY" in body.upper():
            failures.append({"resource": "sitemap", "url": sitemap, "code": "unsafe_xml", "limit_kind": ""})
            continue
        try:
            root = ElementTree.fromstring(body)
        except ElementTree.ParseError:
            failures.append({"resource": "sitemap", "url": sitemap, "code": "invalid_xml", "limit_kind": ""})
            continue
        nodes = list(root.iter())
        if len(nodes) > 2000:
            failures.append({"resource": "sitemap", "url": final,
                             "code": "entry_limit", "limit_kind": ""})
        for node in nodes[:2000]:
            if (node.tag.endswith("}loc") or node.tag == "loc") and node.text:
                add(node.text, "Sitemap URL", final, "sitemap")

    for feed in list(dict.fromkeys(feeds))[:2]:
        if checked >= MAX_REQUESTS:
            break
        try:
            final, headers, body = fetch(feed, "feed", robots)
        except DiscoveryError as error:
            if error.code in ("not_found", "robots_disallowed"):
                continue
            if error.code in ("rate_limited", "unsafe_destination", "request_limit"):
                raise
            failures.append({"resource": "feed", "url": feed, "code": error.code,
                             "limit_kind": error.limit_kind or ""})
            continue
        if "xml" not in headers.get("content-type", "").lower():
            failures.append({"resource": "feed", "url": feed, "code": "unsupported_content_type",
                             "limit_kind": ""})
            continue
        if b"<!DOCTYPE" in body.upper() or b"<!ENTITY" in body.upper():
            failures.append({"resource": "feed", "url": feed, "code": "unsafe_xml", "limit_kind": ""})
            continue
        try:
            root = ElementTree.fromstring(body)
        except ElementTree.ParseError:
            failures.append({"resource": "feed", "url": feed, "code": "invalid_xml", "limit_kind": ""})
            continue
        for node in list(root.iter())[:200]:
            if node.tag.endswith("}link") or node.tag == "link":
                target = node.attrib.get("href") or node.text
                if target:
                    add(target, "Public feed entry", final, "feed")

    # One relevant internal page expands navigation without an unrestricted crawl.
    def internal_priority(link: str) -> int:
        identity = classify(link, "", domain)
        return candidate_priority(Candidate(link, identity[0], identity[1], home,
                                            "homepage", "", identity[2])) if identity else 0

    for link in sorted(dict.fromkeys(relevant_internal), key=internal_priority, reverse=True):
        if checked >= MAX_REQUESTS:
            break
        try:
            final, headers, body = fetch(link, "related_page", robots)
        except DiscoveryError as error:
            if error.code in ("not_found", "robots_disallowed", "access_denied"):
                continue
            if error.code in ("rate_limited", "unsafe_destination", "request_limit"):
                raise
            failures.append({"resource": "related_page", "url": link, "code": error.code,
                             "limit_kind": error.limit_kind or ""})
            continue
        if headers.get("content-type", "").lower().startswith("text/html"):
            page = Links()
            page.feed(body.decode("utf-8", errors="replace"))
            if len(page.links) > 100:
                failures.append({"resource": "related_page", "url": final,
                                 "code": "link_limit", "limit_kind": ""})
            for href, label, _ in page.links[:100]:
                add(href, label, final, "homepage")
        break
    if len(candidates) > MAX_CANDIDATES:
        failures.append({"resource": "candidates", "url": home,
                         "code": "candidate_limit", "limit_kind": ""})
    return prioritized_candidates(list(candidates.values())), checked, failures


def e2e_transport():
    if os.getenv("MARKETRIFT_TEST_MODE") != "1":
        raise DiscoveryError("test_transport_disabled")
    from http.client import HTTPConnection
    raw = os.getenv("DISCOVERY_TEST_BASE_URL", "")
    parsed = urlsplit(raw)
    if parsed.scheme != "http" or parsed.hostname != "127.0.0.1" or not parsed.port:
        raise DiscoveryError("invalid_test_transport")

    def lookup(_host, _port, **_kwargs):
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.215.14", 443))]

    def request(url: str, _ip: str):
        if urlsplit(url).hostname != "example.com":
            raise DiscoveryError("invalid_test_host")
        connection = HTTPConnection("127.0.0.1", parsed.port, timeout=5)
        try:
            connection.request("GET", "/discovery" + urlsplit(url).path)
            response = connection.getresponse()
            return response.status, {key.lower(): value for key, value in response.getheaders()}, response.read(1_000_001)
        finally:
            connection.close()
    return lookup, request


def e2e_search_request(query: str, _token: str) -> tuple[int, dict[str, str], bytes]:
    """Controlled search endpoint exists only in the isolated E2E worker."""
    from http.client import HTTPConnection
    raw = os.getenv("DISCOVERY_TEST_BASE_URL", "")
    parsed = urlsplit(raw)
    if os.getenv("MARKETRIFT_TEST_MODE") != "1" or parsed.hostname != "127.0.0.1" or not parsed.port:
        raise DiscoveryError("invalid_test_transport")
    connection = HTTPConnection("127.0.0.1", parsed.port, timeout=5)
    try:
        connection.request("GET", "/discovery-search?" + urlencode({"q": query}))
        response = connection.getresponse()
        return response.status, {key.lower(): value for key, value in response.getheaders()}, \
            response.read(MAX_SEARCH_RESPONSE_BYTES + 1)
    finally:
        connection.close()


async def discover(payload: object) -> dict:
    job = validate_job(payload)
    async with await psycopg.AsyncConnection.connect(os.environ["RUNTIME_DATABASE_URL"]) as connection:
        await connection.execute("SELECT set_config('app.tenant_id', %s, true)", (job["tenant_id"],))
        row = await (await connection.execute(
            "SELECT p.official_domain,p.official_urls,p.aliases,p.identity_version,p.discovery_paused,"
            "r.status,r.include_external_search,pr.name "
            "FROM marketrift.competitor_profiles p JOIN marketrift.products pr "
            "ON pr.tenant_id=p.tenant_id AND pr.id=p.product_id AND pr.kind='competitor' "
            "JOIN marketrift.discovery_runs r ON r.tenant_id=p.tenant_id AND r.product_id=p.product_id "
            "WHERE p.tenant_id=%s AND p.product_id=%s AND r.id=%s FOR UPDATE OF r",
            (job["tenant_id"], job["product_id"], job["run_id"]))).fetchone()
        if row is None:
            raise DiscoveryError("profile_or_run_not_in_tenant")
        domain, urls, aliases, version, paused, status, include_external, name = row
        if status == "succeeded":
            return {"status": "succeeded", "replayed": True}
        if status != "pending":
            return {"status": status, "replayed": True}
        if paused or version != job["identity_version"]:
            await connection.execute("UPDATE marketrift.discovery_runs SET status='failed',error_code=%s,"
                                     "finished_at=now() WHERE id=%s",
                                     ("discovery_paused" if paused else "identity_changed", job["run_id"]))
            return {"status": "failed", "error_code": "discovery_paused" if paused else "identity_changed"}
        await connection.execute("UPDATE marketrift.discovery_runs SET status='running',started_at=now() WHERE id=%s",
                                 (job["run_id"],))
    try:
        if os.getenv("MARKETRIFT_TEST_MODE") == "1" and os.getenv("DISCOVERY_TEST_BASE_URL"):
            lookup, request = e2e_transport()
            candidates, pages, failures = await asyncio.to_thread(collect, domain, urls, lookup=lookup, request=request)
        else:
            candidates, pages, failures = await asyncio.to_thread(collect, domain, urls)
        external_status = "not_requested"
        external_queries = 0
        external_retry = None
        if include_external:
            if os.getenv("MARKETRIFT_TEST_MODE") == "1" and os.getenv("DISCOVERY_TEST_BASE_URL"):
                outside, external_status, external_queries, external_retry = await asyncio.to_thread(
                    search_external, name, aliases, domain, request=e2e_search_request,
                    token="controlled-e2e", storage_rights=True)
            else:
                outside, external_status, external_queries, external_retry = await asyncio.to_thread(
                    search_external, name, aliases, domain, token=os.getenv("BRAVE_SEARCH_API_KEY"),
                    storage_rights=os.getenv("BRAVE_SEARCH_STORAGE_RIGHTS_CONFIRMED") == "1")
            outside = prioritized_candidates(outside, 15)
            seen = {item.url for item in candidates}
            external_unique = [item for item in outside if item.url not in seen]
            candidates = candidates[:MAX_CANDIDATES - len(external_unique)] + external_unique
            if external_status != "completed":
                failures.append({"resource": "web_search", "url": BRAVE_SEARCH_URL,
                                 "code": external_status, "limit_kind": ""})
        async with await psycopg.AsyncConnection.connect(os.environ["RUNTIME_DATABASE_URL"]) as connection:
            await connection.execute("SELECT set_config('app.tenant_id', %s, true)", (job["tenant_id"],))
            state = await (await connection.execute(
                "SELECT p.identity_version,p.discovery_paused,r.status FROM marketrift.competitor_profiles p "
                "JOIN marketrift.discovery_runs r ON r.tenant_id=p.tenant_id AND r.product_id=p.product_id "
                "WHERE p.tenant_id=%s AND p.product_id=%s AND r.id=%s FOR UPDATE OF r",
                (job["tenant_id"], job["product_id"], job["run_id"]))).fetchone()
            if state != (version, False, "running"):
                raise DiscoveryError("run_state_changed")
            existing_official = {row[0] for row in await (await connection.execute(
                "SELECT canonical_url FROM marketrift.discovery_candidates WHERE tenant_id=%s AND product_id=%s "
                "AND discovery_method IN ('homepage','sitemap','feed')",
                (job["tenant_id"], job["product_id"]))).fetchall()}
            inserted = 0
            for item in candidates:
                if item.method == "web_search" and item.url in existing_official:
                    continue
                result = await connection.execute(
                    "INSERT INTO marketrift.discovery_candidates (tenant_id,product_id,canonical_url,category,"
                    "suggested_type,discovered_from_url,discovery_method,association_evidence,confidence,identity_version,"
                    "search_provider,search_query,classification_version,"
                    "first_discovered_from_url,first_discovery_method) "
                    "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) "
                    "ON CONFLICT (tenant_id,product_id,canonical_url) DO UPDATE SET "
                    "last_examined_at=now(),"
                    "identity_version=CASE WHEN discovery_candidates.status='pending' "
                    "THEN excluded.identity_version ELSE discovery_candidates.identity_version END,"
                    "discovered_from_url=CASE WHEN discovery_candidates.status='pending' "
                    "THEN excluded.discovered_from_url ELSE discovery_candidates.discovered_from_url END,"
                    "discovery_method=CASE WHEN discovery_candidates.status='pending' "
                    "THEN excluded.discovery_method ELSE discovery_candidates.discovery_method END,"
                    "association_evidence=CASE WHEN discovery_candidates.status='pending' "
                    "THEN excluded.association_evidence ELSE discovery_candidates.association_evidence END,"
                    "confidence=CASE WHEN discovery_candidates.status='pending' "
                    "THEN excluded.confidence ELSE discovery_candidates.confidence END,"
                    "category=CASE WHEN discovery_candidates.status='pending' "
                    "THEN excluded.category ELSE discovery_candidates.category END,"
                    "suggested_type=CASE WHEN discovery_candidates.status='pending' "
                    "THEN excluded.suggested_type ELSE discovery_candidates.suggested_type END,"
                    "classification_version=CASE WHEN discovery_candidates.status='pending' "
                    "THEN excluded.classification_version ELSE discovery_candidates.classification_version END,"
                    "search_provider=CASE WHEN discovery_candidates.status='pending' "
                    "THEN excluded.search_provider ELSE discovery_candidates.search_provider END,"
                    "search_query=CASE WHEN discovery_candidates.status='pending' "
                    "THEN excluded.search_query ELSE discovery_candidates.search_query END "
                    "RETURNING (xmax=0)",
                    (job["tenant_id"], job["product_id"], item.url, item.category, item.suggested_type,
                     item.from_url, item.method, item.evidence, item.confidence, version,
                     item.search_provider, item.search_query, CLASSIFICATION_VERSION,
                     item.from_url, item.method))
                inserted += int((await result.fetchone())[0])
            await connection.execute(
                "UPDATE marketrift.discovery_runs SET status='succeeded',pages_examined=%s,candidates_seen=%s,"
                "candidates_new=%s,partial=%s,resource_failures=%s::jsonb,external_search_status=%s,"
                "external_queries=%s,retry_after_at=%s,finished_at=now() "
                "WHERE tenant_id=%s AND id=%s",
                (pages, len(candidates), inserted, bool(failures), json.dumps(failures), external_status,
                 external_queries, external_retry, job["tenant_id"], job["run_id"]))
        return {"status": "succeeded", "seen": len(candidates), "new": inserted, "partial": bool(failures)}
    except (DiscoveryError, PageError) as error:
        code = error.code
        retry = error.retry_at if hasattr(error, "retry_at") else None
        async with await psycopg.AsyncConnection.connect(os.environ["RUNTIME_DATABASE_URL"]) as connection:
            await connection.execute("SELECT set_config('app.tenant_id', %s, true)", (job["tenant_id"],))
            details = [{"resource": error.resource, "url": error.url, "code": code,
                        "limit_kind": error.limit_kind or ""}] if isinstance(error, DiscoveryError) else []
            await connection.execute("UPDATE marketrift.discovery_runs SET status='failed',error_code=%s,"
                                     "retry_after_at=%s,pages_examined=%s,resource_failures=%s::jsonb,"
                                     "finished_at=now() WHERE tenant_id=%s AND id=%s AND status='running'",
                                     (code, retry, getattr(error, "attempted", 0), json.dumps(details),
                                      job["tenant_id"], job["run_id"]))
        return {"status": "failed", "error_code": code}
    except Exception:
        async with await psycopg.AsyncConnection.connect(os.environ["RUNTIME_DATABASE_URL"]) as connection:
            await connection.execute("SELECT set_config('app.tenant_id', %s, true)", (job["tenant_id"],))
            await connection.execute("UPDATE marketrift.discovery_runs SET status='failed',error_code='internal_failure',"
                                     "finished_at=now() WHERE tenant_id=%s AND id=%s AND status='running'",
                                     (job["tenant_id"], job["run_id"]))
        raise
