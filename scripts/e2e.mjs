import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import pg from 'pg';

const apiBase = `http://127.0.0.1:${process.env.API_PORT ?? 3001}/v1`;
const apiProcess = spawn(process.execPath, ['apps/api/dist/main.js'], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
const python = join('apps', 'intelligence', '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const workerProcess = spawn(python, ['-m', 'marketrift_intelligence.worker'], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
const webProcess = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', 'apps/web', '-p', '3000'], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
let errors = '';
const cleanupTenants = [];
for (const child of [apiProcess, workerProcess, webProcess]) child.stderr.on('data', chunk => { errors += String(chunk); });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function call(path, token, options = {}) {
  const headers = new Headers(options.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (options.body && !(options.body instanceof FormData)) headers.set('Content-Type', 'application/json');
  const response = await fetch(`${apiBase}/${path}`, { ...options, headers });
  return { status: response.status, body: await response.json() };
}
async function ready() {
  for (let attempt = 0; attempt < 100; attempt++) {
    try { await fetch(`${apiBase}/me`); return; } catch { await delay(100); }
  }
  throw new Error(`API did not start: ${errors}`);
}
async function waitForImport(id, token) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = await call(`imports/${id}`, token);
    if (result.body.status === 'completed') return result.body;
    if (result.body.status === 'failed') throw new Error(`Import failed: ${JSON.stringify(result.body)}`);
    await delay(200);
  }
  throw new Error(`Import did not complete: ${errors}`);
}

try {
  await ready();
  let webReady = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const page = await (await fetch('http://127.0.0.1:3000')).text();
      if (page.includes('MarketRift') && page.includes('Criar empresa')) { webReady = true; break; }
    } catch { /* Next.js is still starting. */ }
    await delay(100);
  }
  assert.equal(webReady, true, `Web did not serve the onboarding page: ${errors}`);
  const suffix = randomUUID();
  const password = `test-password-${suffix}`;
  const register = company_name => call('auth/register', null, { method: 'POST', body: JSON.stringify({
    email: `${randomUUID()}@example.invalid`, password, display_name: 'E2E Test', company_name,
  }) });
  const a = await register('Test Tenant A');
  const b = await register('Test Tenant B');
  assert.equal(a.status, 201, JSON.stringify(a.body));
  assert.equal(b.status, 201, JSON.stringify(b.body));
  cleanupTenants.push(a.body.tenant_id, b.body.tenant_id);
  const product = await call('products', a.body.token, { method: 'POST', body: JSON.stringify({ name: 'Our App', kind: 'own' }) });
  const competitor = await call('products', a.body.token, { method: 'POST', body: JSON.stringify({ name: 'Competitor', kind: 'competitor' }) });
  assert.equal(product.status, 201, JSON.stringify(product.body));
  assert.equal(competitor.status, 201, JSON.stringify(competitor.body));
  const source = await call('sources', a.body.token, { method: 'POST', body: JSON.stringify({ product_id: competitor.body.id, url: 'https://example.invalid/reviews' }) });
  assert.equal(source.status, 201, JSON.stringify(source.body));
  const forbiddenSource = await call('sources', b.body.token, { method: 'POST', body: JSON.stringify({ product_id: competitor.body.id, url: 'https://example.invalid/reviews' }) });
  assert.equal(forbiddenSource.status, 404);
  const externalKey = `synthetic-${suffix}`;
  const csv = `external_key,source_url,published_at,body,synthetic\n${externalKey},https://example.invalid/reviews/${externalKey},2026-09-01T10:00:00Z,Synthetic e2e review,true\n`;
  async function upload(token, sourceId) {
    const form = new FormData();
    form.append('source_id', sourceId);
    form.append('file', new Blob([csv], { type: 'text/csv' }), 'reviews.csv');
    return call('imports/reviews', token, { method: 'POST', body: form });
  }
  const forbiddenImport = await upload(b.body.token, source.body.id);
  assert.equal(forbiddenImport.status, 404);
  const first = await upload(a.body.token, source.body.id);
  assert.equal(first.status, 201, JSON.stringify(first.body));
  await waitForImport(first.body.id, a.body.token);
  const replay = await upload(a.body.token, source.body.id);
  assert.equal(replay.status, 201, JSON.stringify(replay.body));
  await waitForImport(replay.body.id, a.body.token);
  const documentsA = await call('documents', a.body.token);
  const documentsB = await call('documents', b.body.token);
  const importB = await call(`imports/${first.body.id}`, b.body.token);
  assert.equal(documentsA.body.filter(document => document.external_key === externalKey).length, 1);
  assert.equal(documentsB.body.length, 0);
  assert.equal(importB.status, 404);
  assert.equal(documentsA.body.find(document => document.external_key === externalKey)?.synthetic, true);
  console.log('E2E passed: web, register, product, source, CSV, BullMQ Python, tenant isolation, deduplication');
} catch (error) {
  console.error(error, errors);
  process.exitCode = 1;
} finally {
  apiProcess.kill();
  workerProcess.kill();
  webProcess.kill();
  if (cleanupTenants.length) {
    const admin = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL });
    try {
      await admin.connect();
      await admin.query('BEGIN');
      const members = await admin.query('SELECT user_id FROM marketrift.memberships WHERE tenant_id = ANY($1::uuid[])', [cleanupTenants]);
      for (const table of ['import_rows', 'documents', 'imports', 'sources', 'products', 'memberships']) {
        await admin.query(`DELETE FROM marketrift.${table} WHERE tenant_id = ANY($1::uuid[])`, [cleanupTenants]);
      }
      await admin.query('DELETE FROM marketrift.tenants WHERE id = ANY($1::uuid[])', [cleanupTenants]);
      const userIds = members.rows.map(row => row.user_id);
      if (userIds.length) await admin.query('DELETE FROM marketrift.users WHERE id = ANY($1::uuid[])', [userIds]);
      await admin.query('COMMIT');
    } catch (error) {
      await admin.query('ROLLBACK').catch(() => {});
      console.error('Test data cleanup failed:', error);
      process.exitCode = 1;
    } finally { await admin.end(); }
  }
}
