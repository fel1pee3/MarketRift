import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Overview, WorkspaceNavigation, sessionIdentity, views } from '../../web/src/app/WorkspaceApp';

type Props = Parameters<typeof Overview>[0];

test('navigation has distinct direct URLs for every existing workflow', () => {
  assert.deepEqual(views.map(item => item.href), [
    '/', '/fontes', '/evidencias', '/perguntas', '/revisao', '/avaliacao-busca', '/conta',
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
    signals: { signals: [{ id: 'signal-a', state: 'candidate', summary: '3 Issues públicas',
      source_type: 'github_issues', test_data: false, read_at: null }], alerts: [],
      reconciliation: { last_at: '2026-09-25T12:00:00Z', pending: 0, failed: 0, reasons: [] } },
  };
  const html = renderToStaticMarkup(createElement(Overview, props));
  assert.match(html, /Empresa A/);
  assert.match(html, /2<\/strong><span>Fontes associadas/);
  assert.match(html, /Associações não são documentos distintos/);
  assert.match(html, /coleta parcial por cursor/);
  assert.match(html, /envio à IA não autorizado ou expirado/);
  assert.match(html, /1 candidato\(s\) reais e 0 de TESTE aguardam decisão/);
  assert.doesNotMatch(html, /market share|taxa de reclamações/i);

  const otherTenant = renderToStaticMarkup(createElement(Overview, {
    ...props, tenantName: 'Empresa B', products: [], sources: [], sourceRuns: [],
    signals: { signals: [], alerts: [], reconciliation: { last_at: null, pending: 0, failed: 0, reasons: [] } },
  }));
  assert.doesNotMatch(otherTenant, /Empresa A|Produto A|3 Issues públicas/);
  assert.match(otherTenant, /Nenhuma fonte cadastrada/);
});
