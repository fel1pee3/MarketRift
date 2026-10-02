"""Deterministic RSS/Atom parsing and guarded network tests; no external requests."""
import socket

import pytest

from marketrift_intelligence.feeds import MAX_ENTRIES, MAX_FEED, FeedError, fetch_feed, parse_feed, parse_feed_prefix
from marketrift_intelligence.source_discovery import DiscoveryError

URL = "https://example.com/feed.xml"


def dns(address="93.184.215.14"):
    return lambda *_args, **_kwargs: [(socket.AF_INET,socket.SOCK_STREAM,6,"",(address,443))]


def rss(title="Release", guid="urn:item:1", date="Tue, 29 Sep 2026 12:00:00 GMT"):
    return (f'<rss version="2.0"><channel><item><guid>{guid}</guid>'
            f'<title>{title}</title><link>https://example.com/blog/1</link>'
            f'<pubDate>{date}</pubDate><description>Metadata only</description>'
            '</item></channel></rss>').encode()


def atom():
    return (b'<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>urn:one</id>'
            b'<title>Update</title><link rel="alternate" href="https://example.com/post" />'
            b'<updated>2026-09-29T12:00:00Z</updated></entry></feed>')


def test_rss_atom_missing_date_guid_repeat_and_edits():
    items, complete = parse_feed(rss(), URL)
    assert complete and len(items) == 1 and items[0].published_at.year == 2026
    assert items[0].external_id == "urn:item:1"
    assert parse_feed(rss(title="Edited"), URL)[0][0].content_sha256 != items[0].content_sha256
    no_date, _ = parse_feed(rss(date="29 September"), URL)
    assert no_date[0].date_literal == "29 September" and no_date[0].published_at is None
    atom_items, _ = parse_feed(atom(), URL)
    assert atom_items[0].title == "Update" and atom_items[0].url == "https://example.com/post"
    body = rss().replace(b'</channel>', b'<item><guid>urn:item:1</guid><title>Release</title>'
        b'<link>https://example.com/blog/1</link></item></channel>')
    repeated, complete = parse_feed(body, URL)
    assert len(repeated) == 1 and complete is False


def test_xml_entities_limits_and_partial_feed():
    with pytest.raises(FeedError, match="xml_entities_forbidden"):
        parse_feed(b'<!DOCTYPE rss [<!ENTITY x SYSTEM "file:///etc/passwd">]><rss version="2.0"/>', URL)
    with pytest.raises(FeedError, match="invalid_xml"):
        parse_feed(b'<rss', URL)
    with pytest.raises(FeedError, match="unsupported_feed_format"):
        parse_feed(b'<html></html>', URL)
    item = '<item><guid>{}</guid><title>News</title><link>https://example.com/1</link></item>'
    body = ('<rss version="2.0"><channel>' + ''.join(item.format(i) for i in range(MAX_ENTRIES + 1))
            + '</channel></rss>').encode()
    entries, complete = parse_feed(body, URL)
    assert len(entries) == MAX_ENTRIES and complete is False


def test_304_conditional_headers_and_robots():
    called = []
    def request(url, _ip, limit, headers=None):
        called.append((url,limit,headers))
        if url.endswith('robots.txt'):
            return 200, {}, b'User-agent: *\nAllow: /\n'
        return 304, {}, b''
    entries, complete, etag, _modified, unchanged = fetch_feed(URL,etag='"v1"',
        modified='Tue, 29 Sep 2026 12:00:00 GMT',lookup=dns(),request=request)
    assert entries == [] and complete and unchanged and etag == '"v1"'
    assert called[1][2] == {'If-None-Match':'"v1"','If-Modified-Since':'Tue, 29 Sep 2026 12:00:00 GMT'}


def test_robots_private_redirect_rate_limit_and_oversize():
    def blocked(url, *_args):
        return (200,{},b'User-agent: *\nDisallow: /') if url.endswith('robots.txt') else (200,{},rss())
    with pytest.raises(FeedError, match="robots_disallowed"):
        fetch_feed(URL,lookup=dns(),request=blocked)
    with pytest.raises(FeedError, match="robots_unavailable"):
        fetch_feed(URL,lookup=dns(),request=lambda *_args: (_ for _ in ()).throw(DiscoveryError('response_too_large')))
    calls = []
    def redirect(url, *_args):
        calls.append(url)
        return (404,{},b'') if url.endswith('robots.txt') else (302,{'location':'https://127.0.0.1/internal'},b'')
    with pytest.raises(FeedError, match="unsafe_redirect"):
        fetch_feed(URL,lookup=dns(),request=redirect)
    assert len(calls) == 2
    def limited(url, *_args):
        return (404,{},b'') if url.endswith('robots.txt') else (429,{'retry-after':'120'},b'')
    with pytest.raises(FeedError, match="rate_limited") as error:
        fetch_feed(URL,lookup=dns(),request=limited)
    assert error.value.retry_at is not None
    def large(url, *_args):
        if url.endswith('robots.txt'): return 404,{},b''
        raise DiscoveryError('response_too_large')
    with pytest.raises(FeedError, match="response_too_large"):
        fetch_feed(URL,lookup=dns(),request=large)
    with pytest.raises(FeedError, match="robots_unavailable"):
        fetch_feed(URL,lookup=dns('127.0.0.1'),request=limited)


def test_large_atom_bounded_prefix_complete_entries_and_partial_coverage():
    entry = (b'<entry><id>urn:one</id><title>Update</title>'
             b'<link href="https://example.com/post"/><updated>2026-10-01T12:00:00Z</updated></entry>')
    large = b'<feed xmlns="http://www.w3.org/2005/Atom">' + entry + (
        b'<!--' + b'a' * (MAX_FEED + 100) + b'-->') + b'</feed>'
    assert len(large) > MAX_FEED
    calls = []
    def prefix(url, _ip, limit, _headers):
        calls.append((url,limit))
        return 200, {'content-type':'application/atom+xml','content-length':str(len(large))},large[:limit],False
    def regular(url, *_args):
        assert url.endswith('/robots.txt')
        return 200,{},b'User-agent: *\nAllow: /\n'
    entries, complete, *_ = fetch_feed(URL,lookup=dns(),request=regular,request_prefix=prefix)
    assert len(entries) == 1 and entries[0].external_id == 'urn:one'
    assert complete is False and calls == [(URL,MAX_FEED)]
    assert parse_feed_prefix(large[:MAX_FEED],URL)[1] is False


def test_partial_xml_rejects_entities_bad_prefix_and_missing_complete_entry():
    malicious = (b'<!DOCTYPE feed [<!ENTITY x SYSTEM "file:///etc/passwd">]>'
        b'<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>&x;</title></entry>')
    with pytest.raises(FeedError, match='xml_entities_forbidden'):
        parse_feed_prefix(malicious,URL)
    with pytest.raises(FeedError, match='invalid_xml'):
        parse_feed_prefix(b'<feed><entry></feed></entry>',URL)
    with pytest.raises(FeedError, match='no_complete_entries_within_limit'):
        parse_feed_prefix(b'<feed><entry><title>Incomplete',URL)
    with pytest.raises(FeedError, match='invalid_xml'):
        parse_feed(b'<feed><entry></feed>',URL)
    with pytest.raises(FeedError, match='unsupported_feed_format'):
        parse_feed_prefix(b'<rss version="1.0"><channel><item><title>x</title></item>',URL)


def test_dense_atom_prefix_validates_only_first_twenty_closed_entries():
    detail = b''.join(f'<tag{index}>value</tag{index}>'.encode() for index in range(25))
    items = b''.join((b'<entry><id>urn:item:' + str(index).encode() + b'</id>'
        b'<title>Update</title><link href="https://example.com/post/' + str(index).encode()
        + b'"/>' + detail + b'</entry>') for index in range(163))
    body = b'<feed xmlns="http://www.w3.org/2005/Atom">' + items + b'<!--' + b'x' * MAX_FEED
    assert len(body) > MAX_FEED
    entries, complete = parse_feed_prefix(body[:MAX_FEED],URL)
    assert len(entries) == MAX_ENTRIES and complete is False
    assert [item.external_id for item in entries] == [f'urn:item:{index}' for index in range(MAX_ENTRIES)]
