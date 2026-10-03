import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DiscoveryPanel, NormalOverview, WorkspaceNavigation, sessionIdentity, views } from '../../web/src/app/WorkspaceApp';

type Props = Parameters<typeof NormalOverview>[0];

test('navigation has distinct direct URLs for every existing workflow', () => {
  assert.deepEqual(views.map(item => item.href), [
    '/', '/concorrentes', '/investigar', '/configuracoes', '/fontes', '/evidencias', '/perguntas',
    '/revisao', '/avaliacao-busca', '/avaliacao-b2b', '/conta',
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

test('normal overview shows an honest empty state and only reviewed evidence', () => {
  const props: Props = { tenantName: 'Empresa A', data: {
    products: [], sources: [], discovery: [], suggestions: [], attention: [],
  } };
  const empty = renderToStaticMarkup(createElement(NormalOverview, props));
  assert.match(empty, /Ainda não há concorrentes acompanhados/);
  assert.match(empty, /Ainda não há evidências coletadas/);
  assert.doesNotMatch(empty, /Fixture interna|controlled-hash|synthetic/i);
  const populated = renderToStaticMarkup(createElement(NormalOverview, { tenantName: 'Empresa B', data: {
    ...props.data,
    products: [{ id: 'product-a', name: 'Concorrente público', kind: 'competitor', website_url: null,
      usage_classification: 'real', official_domain: 'example.org', discovery_paused: false }],
    sources: [{ id: 'source-a', product_id: 'product-a', source_type: 'github_issues', url: 'https://github.com/example/repo',
      evidence_count: 1, last_observed_at: '2026-10-03T12:00:00Z', partial: true, blocked: false,
      association_confirmed: false }],
  } }));
  assert.match(populated, /Issues públicas/);
  assert.match(populated, /cobertura parcial/);
  assert.doesNotMatch(populated, /Empresa A/);
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
