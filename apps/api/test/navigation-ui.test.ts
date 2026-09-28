import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DiscoveryPanel, Overview, WorkspaceNavigation, sessionIdentity, views } from '../../web/src/app/WorkspaceApp';

type Props = Parameters<typeof Overview>[0];

test('navigation has distinct direct URLs for every existing workflow', () => {
  assert.deepEqual(views.map(item => item.href), [
    '/', '/fontes', '/evidencias', '/perguntas', '/revisao', '/avaliacao-busca', '/avaliacao-b2b', '/conta',
  ]);
  assert.equal(new Set(views.map(item => item.id)).size, views.length);
  const html = renderToStaticMarkup(createElement(WorkspaceNavigation, { view: 'questions' }));
  assert.match(html, /aria-label="Navegação principal"/);
  assert.match(html, /<a aria-current="page" href="\/perguntas">Perguntas<\/a>/);
  assert.equal((html.match(/aria-current="page"/g) ?? []).length, 1);
});

test('late responses from another tenant or role cannot share the active session key', () => {
  const first = { user_id: 'user-a', tenant_id: 'tenant-a', role: 'owner' as const, csrf_token: 'same-csrf' };
  assert.notEqual(sessionIdentity(first), sessionIdentity({ ...first, tenant_id: 'tenant-b' }));
  assert.notEqual(sessionIdentity(first), sessionIdentity({ ...first, role: 'viewer' }));
});

test('overview separates source associations, coverage warnings and human decisions', () => {
  const source: Props['sources'][number] = {
    id: 'source-a', product_id: 'product-a', source_type: 'github_issues', url: 'https://github.com/example/repo',
    last_checked_at: '2026-09-25T12:00:00Z', external_product_id: null, access_environment: null,
    access_status: 'available', rights_recorded: false, rights_expires_at: null,
    storage_permitted: false, external_ai_permitted: false, ai_rights_recorded: false,
    ai_provider: null, ai_rights_expires_at: null, ai_rights_revoked_at: null,
  };
  const props: Props = {
    tenantName: 'Empresa A', role: 'owner',
    products: [{ id: 'product-a', name: 'Produto A', kind: 'competitor', website_url: null }],
    sources: [source, { ...source, id: 'source-b', source_type: 'b2b_csv_review',
      access_environment: 'production', url: 'https://example.com/reviews' }],
    sourceRuns: [{ id: 'run-a', source_id: 'source-a', status: 'succeeded', documents_seen: 5,
      documents_new: 3, documents_updated: 0, documents_ignored: 0, scan_complete: false,
      pages_fetched: 1, pull_requests_skipped: 0, error_code: null, retry_after_at: null,
      started_at: '2026-09-25T11:59:00Z', finished_at: '2026-09-25T12:00:00Z' }],
    pages: { sources: [], runs: [], snapshots: [], changes: [] },
    discovery: { profiles: [], runs: [], search_provider: 'brave_optional', candidates: [{
      id: 'candidate-a', product_id: 'product-a', canonical_url: 'https://example.com/pricing',
      category: 'product', suggested_type: 'pricing_page', discovered_from_url: 'https://example.com/',
      discovery_method: 'homepage', association_evidence: 'Pricing', confidence: 'official_host',
      search_provider: null, search_query: null,
      status: 'pending', linked_source_id: null, existing_source_id: null, identity_version: 1,
      classification_version: 2, first_discovered_from_url: 'https://example.com/',
      first_discovery_method: 'homepage',
      first_seen_at: '2026-09-25T12:00:00Z', last_examined_at: '2026-09-25T12:00:00Z',
    }] },
    signals: { signals: [{ id: 'signal-a', state: 'candidate', summary: '3 Issues públicas',
      source_type: 'github_issues', test_data: false, read_at: null }], alerts: [],
      reconciliation: { last_at: '2026-09-25T12:00:00Z', pending: 0, failed: 0, reasons: [] } },
  };
  const html = renderToStaticMarkup(createElement(Overview, props));
  assert.match(html, /Empresa A/);
  assert.match(html, /2<\/strong><span>Fontes associadas/);
  assert.match(html, /1 URL\(s\) distinta\(s\) em 1 associação\(ões\) candidata\(s\)/);
  assert.match(html, /Associações não são documentos distintos/);
  assert.match(html, /coleta parcial por cursor/);
  assert.match(html, /envio à IA não autorizado ou expirado/);
  assert.match(html, /1 candidato\(s\) reais e 0 de TESTE aguardam decisão/);
  assert.doesNotMatch(html, /market share|taxa de reclamações/i);

  const otherTenant = renderToStaticMarkup(createElement(Overview, {
    ...props, tenantName: 'Empresa B', products: [], sources: [], sourceRuns: [],
    discovery: { profiles: [], runs: [], candidates: [], search_provider: 'brave_optional' },
    signals: { signals: [], alerts: [], reconciliation: { last_at: null, pending: 0, failed: 0, reasons: [] } },
  }));
  assert.doesNotMatch(otherTenant, /Empresa A|Produto A|3 Issues públicas/);
  assert.match(otherTenant, /Nenhuma fonte cadastrada/);
});

test('discovery review distinguishes an existing index from an individual changelog entry', () => {
  const props: Parameters<typeof DiscoveryPanel>[0] = {
    products: [{ id: 'product-a', name: 'Vercel demo', kind: 'competitor', website_url: null }],
    role: 'owner', busy: false, act: async () => {}, request: async () => ({}), refresh: async () => {},
    data: {
      search_provider: 'brave_optional', runs: [], profiles: [{
        product_id: 'product-a', product_name: 'Vercel demo', official_domain: 'vercel.com',
        aliases: [], country_code: null, languages: [], official_urls: [],
        identity_version: 1, discovery_paused: false,
      }],
      candidates: [
        { id: 'index', product_id: 'product-a', canonical_url: 'https://vercel.com/changelog',
          category: 'product', suggested_type: 'release_notes', discovered_from_url: 'https://vercel.com/',
          discovery_method: 'homepage', association_evidence: 'Changelog', confidence: 'official_host',
          search_provider: null, search_query: null, status: 'confirmed', linked_source_id: null,
          existing_source_id: 'source-a', identity_version: 1, classification_version: 1,
          first_discovered_from_url: 'https://vercel.com/', first_discovery_method: 'homepage',
          first_seen_at: '2026-09-26T12:00:00Z', last_examined_at: '2026-09-26T12:00:00Z' },
        { id: 'entry', product_id: 'product-a',
          canonical_url: 'https://vercel.com/changelog/unlimited-stores-on-every-plan',
          category: 'product', suggested_type: 'changelog_entry',
          discovered_from_url: 'https://vercel.com/changelog', discovery_method: 'homepage',
          association_evidence: 'Unlimited stores on every plan', confidence: 'official_host',
          search_provider: null, search_query: null, status: 'pending', linked_source_id: null,
          existing_source_id: null, identity_version: 1, classification_version: 2,
          first_discovered_from_url: 'https://vercel.com/changelog', first_discovery_method: 'homepage',
          first_seen_at: '2026-09-26T12:00:00Z', last_examined_at: '2026-09-26T12:00:00Z' },
      ],
    },
  };
  const html = renderToStaticMarkup(createElement(DiscoveryPanel, props));
  assert.match(html, /Fonte existente/);
  assert.match(html, /changelog_entry/);
  assert.match(html, /Marcar como conte/);
  assert.doesNotMatch(html, /Confirmar associa/);
});
