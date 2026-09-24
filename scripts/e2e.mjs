import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import pg from 'pg';

const apiPort = Number(process.env.E2E_API_PORT ?? 3211);
const webPort = Number(process.env.E2E_WEB_PORT ?? 3210);
const webOrigin = `http://localhost:${webPort}`;
const apiBase = `http://localhost:${apiPort}/v1`;
// Use a separate local Redis database so an already running development worker
// cannot consume E2E jobs with a different analysis provider.
const e2eRedisUrl = new URL(process.env.E2E_REDIS_URL ?? process.env.REDIS_URL);
if (!process.env.E2E_REDIS_URL) e2eRedisUrl.pathname = '/15';
const childEnv = { ...process.env, API_PORT: String(apiPort), WEB_ORIGIN: webOrigin,
  REDIS_URL: e2eRedisUrl.toString() };
const apiProcess = spawn(process.execPath, ['apps/api/dist/main.js'], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
const python = join('apps', 'intelligence', '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const workerProcess = spawn(python, ['-m', 'marketrift_intelligence.worker'], {
  env: { ...childEnv, ANALYSIS_PROVIDER: 'test', MARKETRIFT_TEST_MODE: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const webProcess = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', 'apps/web', '-p', String(webPort)], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
const children = [apiProcess, workerProcess, webProcess];
let errors = '';
const cleanupTenants = [];
const cleanupEmails = [];
for (const child of children) {
  child.stderr.on('data', chunk => { errors += String(chunk); });
  child.on('error', error => { errors += String(error); });
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

class Browser {
  cookie = '';
  csrf = '';
  async call(path, options = {}) {
    const { withoutCsrf = false, origin = webOrigin, ...init } = options;
    const headers = new Headers(init.headers);
    if (this.cookie) headers.set('Cookie', this.cookie);
    if (init.method && !['GET', 'HEAD'].includes(init.method)) {
      headers.set('Origin', origin);
      if (!withoutCsrf && this.csrf) headers.set('X-CSRF-Token', this.csrf);
    }
    if (init.body && !(init.body instanceof FormData)) headers.set('Content-Type', 'application/json');
    const response = await fetch(`${apiBase}/${path}`, { ...init, headers });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) this.cookie = setCookie.split(';')[0];
    const body = response.status === 204 ? null : await response.json();
    if (body?.csrf_token) this.csrf = body.csrf_token;
    return { status: response.status, body, headers: response.headers };
  }
}
async function ready() {
  for (let attempt = 0; attempt < 100; attempt++) {
    try { await fetch(`${apiBase}/me`); return; } catch { await delay(100); }
  }
  throw new Error(`API did not start: ${errors}`);
}
async function waitForImport(browser, id) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = await browser.call(`imports/${id}`);
    if (result.body.status === 'completed') return result.body;
    if (result.body.status === 'failed') throw new Error(`Import failed: ${JSON.stringify(result.body)}`);
    await delay(200);
  }
  throw new Error(`Import did not complete: ${errors}`);
}
async function waitForAnalysis(browser, documentId) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = await browser.call('documents');
    const document = result.body.find(item => item.id === documentId);
    if (document?.analysis_status === 'completed') return document;
    if (document?.analysis_status === 'failed') throw new Error(`Analysis failed: ${JSON.stringify(document)}`);
    await delay(200);
  }
  throw new Error(`Analysis did not complete: ${errors}`);
}

try {
  await ready();
  let webReady = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const response = await fetch(webOrigin);
      const page = await response.text();
      if (response.ok && page.includes('MarketRift') && page.includes('Verificando sessão')) { webReady = true; break; }
    } catch { /* web is starting */ }
    await delay(100);
  }
  assert.equal(webReady, true, `Web did not serve the onboarding page: ${errors}`);

  const suffix = randomUUID();
  const password = `test-password-${suffix}`;
  const a = new Browser();
  const b = new Browser();
  const aEmail = `owner-a-${suffix}@example.invalid`;
  const bEmail = `owner-b-${suffix}@example.invalid`;
  async function register(browser, email, companyName, invitationToken) {
    const payload = { email, password, display_name: 'E2E Test',
      ...(companyName ? { company_name: companyName } : {}),
      ...(invitationToken ? { invitation_token: invitationToken } : {}) };
    const result = await browser.call('auth/register', { method: 'POST', body: JSON.stringify(payload) });
    if (result.status === 201) cleanupEmails.push(email);
    return result;
  }
  const registeredA = await register(a, aEmail, 'Test Tenant A');
  if (registeredA.status === 201) cleanupTenants.push(registeredA.body.tenant_id);
  const registeredB = await register(b, bEmail, 'Test Tenant B');
  if (registeredB.status === 201) cleanupTenants.push(registeredB.body.tenant_id);
  assert.equal(registeredA.status, 201, JSON.stringify(registeredA.body));
  assert.equal(registeredB.status, 201, JSON.stringify(registeredB.body));
  assert.equal(registeredA.body.role, 'owner');
  assert.equal('token' in registeredA.body, false);
  assert.match(registeredA.headers.get('set-cookie') ?? '', /HttpOnly/i);
  assert.match(registeredA.headers.get('set-cookie') ?? '', /SameSite=Lax/i);
  assert.equal((await a.call('auth/session')).body.tenant_id, registeredA.body.tenant_id);
  assert.equal((await a.call('products', { method: 'POST', withoutCsrf: true, body: JSON.stringify({ name: 'Rejected', kind: 'own' }) })).status, 403);
  assert.equal((await a.call('products', { method: 'POST', origin: 'https://attacker.invalid', body: JSON.stringify({ name: 'Rejected', kind: 'own' }) })).status, 403);

  const product = await a.call('products', { method: 'POST', body: JSON.stringify({ name: 'Our App', kind: 'own' }) });
  const competitor = await a.call('products', { method: 'POST', body: JSON.stringify({ name: 'Competitor', kind: 'competitor' }) });
  assert.equal(product.status, 201, JSON.stringify(product.body));
  assert.equal(competitor.status, 201, JSON.stringify(competitor.body));
  const source = await a.call('sources', { method: 'POST', body: JSON.stringify({ product_id: competitor.body.id, url: 'https://example.invalid/reviews' }) });
  assert.equal(source.status, 201, JSON.stringify(source.body));
  assert.equal((await b.call('sources', { method: 'POST', body: JSON.stringify({ product_id: competitor.body.id, url: 'https://example.invalid/reviews' }) })).status, 404);

  async function invite(browser, email, role) {
    const result = await browser.call('invitations', { method: 'POST', body: JSON.stringify({ email, role }) });
    assert.equal(result.status, 201, JSON.stringify(result.body));
    return result.body.invitation_token;
  }
  const adminEmail = `admin-${suffix}@example.invalid`;
  const analystEmail = `analyst-${suffix}@example.invalid`;
  const viewerEmail = `viewer-${suffix}@example.invalid`;
  const adminToken = await invite(a, adminEmail, 'admin');
  const analystToken = await invite(a, analystEmail, 'analyst');
  const viewerToken = await invite(a, viewerEmail, 'viewer');
  const admin = new Browser();
  const analyst = new Browser();
  const viewer = new Browser();
  assert.equal((await register(admin, adminEmail, null, adminToken)).body.role, 'admin');
  assert.equal((await register(analyst, analystEmail, null, analystToken)).body.role, 'analyst');
  assert.equal((await register(viewer, viewerEmail, null, viewerToken)).body.role, 'viewer');
  assert.equal((await register(new Browser(), `wrong-${suffix}@example.invalid`, null, analystToken)).status, 400);
  assert.equal((await analyst.call('invitations/accept', { method: 'POST', body: JSON.stringify({ invitation_token: analystToken }) })).status, 400);
  assert.equal((await admin.call('invitations', { method: 'POST', body: JSON.stringify({ email: 'another@example.invalid', role: 'admin' }) })).status, 403);
  assert.equal((await analyst.call('invitations', { method: 'POST', body: JSON.stringify({ email: 'another@example.invalid', role: 'viewer' }) })).status, 403);
  assert.equal((await viewer.call('products', { method: 'POST', body: JSON.stringify({ name: 'Forbidden', kind: 'competitor' }) })).status, 403);
  assert.equal((await analyst.call('products', { method: 'POST', body: JSON.stringify({ name: 'Forbidden', kind: 'competitor' }) })).status, 403);
  assert.equal((await admin.call('sources', { method: 'POST', body: JSON.stringify({ product_id: competitor.body.id, url: 'https://example.invalid/other' }) })).status, 201);

  const externalKey = `synthetic-${suffix}`;
  const positiveKey = `positive-${suffix}`;
  const csv = `external_key,source_url,published_at,body,synthetic\n${externalKey},https://example.invalid/reviews/${externalKey},2026-09-01T10:00:00Z,O suporte demorou três dias e o preço aumentou sem aviso.,true\n${positiveKey},https://example.invalid/reviews/${positiveKey},2026-09-02T10:00:00Z,Gostei muito da facilidade de uso.,true\n`;
  async function upload(browser, sourceId) {
    const form = new FormData();
    form.append('source_id', sourceId);
    form.append('file', new Blob([csv], { type: 'text/csv' }), 'reviews.csv');
    return browser.call('imports/reviews', { method: 'POST', body: form });
  }
  assert.equal((await upload(viewer, source.body.id)).status, 403);
  assert.equal((await upload(b, source.body.id)).status, 404);
  const first = await upload(analyst, source.body.id);
  assert.equal(first.status, 201, JSON.stringify(first.body));
  await waitForImport(analyst, first.body.id);
  const replay = await upload(analyst, source.body.id);
  assert.equal(replay.status, 201, JSON.stringify(replay.body));
  await waitForImport(analyst, replay.body.id);
  const documentsA = await a.call('documents');
  assert.equal(documentsA.body.filter(document => document.external_key === externalKey).length, 1);
  assert.equal((await b.call('documents')).body.length, 0);
  assert.equal((await b.call(`imports/${first.body.id}`)).status, 404);
  const analyzed = await waitForAnalysis(a, documentsA.body.find(document => document.external_key === externalKey).id);
  assert.deepEqual(analyzed.issues.map(issue => issue.category).sort(), ['price', 'support']);
  assert.equal(analyzed.analysis_model, 'controlled-test-fixture-v1');
  assert.equal(analyzed.synthetic, true);
  assert(analyzed.issues.every(issue => analyzed.body.includes(issue.evidence_quote)));
  const positive = await waitForAnalysis(a, documentsA.body.find(document => document.external_key === positiveKey).id);
  assert.deepEqual(positive.issues, []);
  assert.equal((await a.call(`documents/${analyzed.id}/analyze`, { method: 'POST' })).body.status, 'completed');
  assert.equal((await b.call(`documents/${analyzed.id}/analyze`, { method: 'POST' })).status, 404);
  assert.equal((await viewer.call(`documents/${analyzed.id}/analyze`, { method: 'POST' })).status, 403);

  const members = await a.call('members');
  const viewerId = members.body.find(member => member.email === viewerEmail).user_id;
  const adminId = members.body.find(member => member.email === adminEmail).user_id;
  assert.equal((await admin.call(`members/${adminId}`, { method: 'PATCH', body: JSON.stringify({ role: 'owner' }) })).status, 403);
  assert.equal((await a.call(`members/${registeredA.body.user_id}`, { method: 'PATCH', body: JSON.stringify({ role: 'viewer' }) })).status, 409);
  assert.equal((await a.call(`members/${registeredA.body.user_id}`, { method: 'DELETE' })).status, 409);
  assert.equal((await a.call(`members/${viewerId}`, { method: 'PATCH', body: JSON.stringify({ role: 'analyst' }) })).status, 200);
  const promotedUpload = await upload(viewer, source.body.id);
  assert.equal(promotedUpload.status, 201);
  await waitForImport(viewer, promotedUpload.body.id);
  assert.equal((await a.call(`members/${viewerId}`, { method: 'PATCH', body: JSON.stringify({ role: 'viewer' }) })).status, 200);
  assert.equal((await upload(viewer, source.body.id)).status, 403);

  const expiredToken = await invite(a, bEmail, 'viewer');
  const db = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL });
  await db.connect();
  try {
    await db.query("UPDATE marketrift.member_invitations SET expires_at = now() - interval '1 minute' WHERE token_hash = $1",
      [createHash('sha256').update(expiredToken).digest('hex')]);
  } finally { await db.end(); }
  assert.equal((await b.call('invitations/accept', { method: 'POST', body: JSON.stringify({ invitation_token: expiredToken }) })).status, 400);
  assert.equal((await b.call('invitations/accept', { method: 'POST', body: JSON.stringify({ invitation_token: 'f'.repeat(64) }) })).status, 400);
  const validToken = await invite(b, analystEmail, 'viewer');
  const oldCookie = analyst.cookie;
  const accepted = await analyst.call('invitations/accept', { method: 'POST', body: JSON.stringify({ invitation_token: validToken }) });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  assert.equal(accepted.body.tenant_id, registeredB.body.tenant_id);
  assert.equal(accepted.body.tenants.length, 2);
  const oldSession = new Browser(); oldSession.cookie = oldCookie;
  assert.equal((await oldSession.call('auth/session')).status, 401);
  assert.equal((await analyst.call(`imports/${first.body.id}`)).status, 404);
  assert.equal((await upload(analyst, source.body.id)).status, 403);
  assert.equal((await analyst.call('auth/switch-tenant', { method: 'POST', body: JSON.stringify({ tenant_id: randomUUID() }) })).status, 403);
  const switched = await analyst.call('auth/switch-tenant', { method: 'POST', body: JSON.stringify({ tenant_id: registeredA.body.tenant_id }) });
  assert.equal(switched.status, 200, JSON.stringify(switched.body));
  assert.equal(switched.body.role, 'analyst');
  assert.equal((await analyst.call('documents')).body.filter(document => document.external_key === externalKey).length, 1);

  assert.equal((await viewer.call('auth/logout', { method: 'POST', withoutCsrf: true })).status, 403);
  assert.equal((await viewer.call('auth/logout', { method: 'POST' })).status, 204);
  assert.equal((await viewer.call('auth/session')).status, 401);
  const relogin = await viewer.call('auth/login', { method: 'POST', body: JSON.stringify({ email: viewerEmail, password }) });
  assert.equal(relogin.status, 200);
  assert.equal((await viewer.call('auth/session')).body.role, 'viewer');
  assert.equal((await a.call(`members/${adminId}`, { method: 'DELETE' })).status, 204);
  assert.equal((await admin.call('auth/session')).status, 401);
  console.log('E2E passed: sessions, RBAC, CSV ingest, queued analysis, literal evidence, replay and tenant isolation');
} catch (error) {
  console.error(error, errors);
  process.exitCode = 1;
} finally {
  for (const child of children) child.kill();
  if (cleanupTenants.length) {
    const admin = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL });
    try {
      await admin.connect();
      await admin.query('BEGIN');
      const users = await admin.query('SELECT id FROM marketrift.users WHERE email = ANY($1::text[])', [cleanupEmails]);
      await admin.query('DELETE FROM marketrift.member_invitations WHERE tenant_id = ANY($1::uuid[])', [cleanupTenants]);
      await admin.query('DELETE FROM marketrift.browser_sessions WHERE tenant_id = ANY($1::uuid[])', [cleanupTenants]);
      for (const table of ['insights', 'document_analyses', 'import_rows', 'documents', 'imports', 'sources', 'products', 'memberships']) {
        await admin.query(`DELETE FROM marketrift.${table} WHERE tenant_id = ANY($1::uuid[])`, [cleanupTenants]);
      }
      await admin.query('DELETE FROM marketrift.tenants WHERE id = ANY($1::uuid[])', [cleanupTenants]);
      const userIds = users.rows.map(row => row.id);
      if (userIds.length) await admin.query('DELETE FROM marketrift.users WHERE id = ANY($1::uuid[])', [userIds]);
      await admin.query('COMMIT');
    } catch (error) {
      await admin.query('ROLLBACK').catch(() => {});
      console.error('Test data cleanup failed:', error);
      process.exitCode = 1;
    } finally { await admin.end(); }
  }
}
