import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
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
let steamBody = 'O suporte demorou três dias e o preço aumentou sem aviso.';
let steamUpdated = 1780000000;
let steamVotedUp = false;
const steamRequests = [];
let pagePrice = '10';
let releaseVersion = 1;
let flakyAttempts = 0;
const pageRequests = [];
let discussionBody = 'The integration fails when the account name has spaces.';
let discussionUpdated = '2026-09-24T12:00:00Z';
const discussionRequests = [];
const steamMock = createServer((request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  if (url.pathname === '/graphql') {
    let raw = '';
    request.on('data', chunk => { raw += chunk; });
    request.on('end', () => {
      const variables = JSON.parse(raw).variables;
      discussionRequests.push({ variables, authorized: request.headers.authorization === 'Bearer e2e-read-only-placeholder' });
      const number = variables.after === 'cursor-one' ? 2 : 1;
      const item = { id: `D_${number}`, number, title: number === 1 ? 'Integration feedback' : 'Community announcement',
        body: number === 1 ? discussionBody : '', createdAt: '2026-09-01T10:00:00Z',
        updatedAt: number === 1 ? discussionUpdated : '2026-09-02T10:00:00Z',
        url: `https://github.com/example/repo/discussions/${number}`, closed: false,
        category: { name: number === 1 ? 'Ideas' : 'Announcements' }, author: { login: 'public-user' } };
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ data: { repository: { isPrivate: false, hasDiscussionsEnabled: true,
        discussions: { nodes: [item], pageInfo: { endCursor: number === 1 ? 'cursor-one' : 'cursor-two',
          hasNextPage: number === 1 } } } } }));
    });
    return;
  }
  if (url.pathname.startsWith('/web-page/')) {
    pageRequests.push(url.pathname);
    if (url.pathname === '/web-page/robots.txt') { response.writeHead(404); response.end(); return; }
    if (url.pathname === '/web-page/pricing') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(`<main><section class="plan"><h2>Pro</h2><p>USD ${pagePrice} per month</p><p>API access</p></section><footer>Updated today</footer></main>`);
      return;
    }
    if (url.pathname === '/web-page/changelog') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(`<main><h1>Changelog</h1><article><h2>Version ${releaseVersion}</h2>`
        + `<time datetime="2026-09-24">24 Sep</time><a href="/releases/${releaseVersion}">Details</a>`
        + `<p>Fixed product sync in version ${releaseVersion}.</p></article></main>`);
      return;
    }
    if (url.pathname === '/web-page/changelog-flaky') {
      flakyAttempts += 1;
      if (flakyAttempts === 1) {
        response.writeHead(503, { 'Retry-After': '1' }); response.end(); return;
      }
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end('<main><h1>Changelog</h1><article><h2>Version 1</h2>'
        + '<a href="/releases/1">Details</a><p>Fixed sync.</p></article></main>');
      return;
    }
    if (url.pathname === '/web-page/') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end('<main><h1>Perspectives</h1><article><h2>AI in banking</h2>'
        + '<a href="/insights/ai">Read more</a><p>Author: Alex. Read more about trends.</p>'
        + '</article></main>');
      return;
    }
    response.writeHead(404); response.end(); return;
  }
  steamRequests.push(url);
  response.setHeader('Content-Type', 'application/json');
  if (url.pathname !== '/appreviews/620') {
    response.writeHead(404);
    response.end(JSON.stringify({ success: 0 }));
    return;
  }
  response.end(JSON.stringify({ success: 1, cursor: 'next-page', reviews: [{
    recommendationid: '901001', review: steamBody, language: 'english',
    timestamp_created: 1779000000, timestamp_updated: steamUpdated,
    voted_up: steamVotedUp, author: { steamid: 'must-not-be-stored' },
  }] }));
});
await new Promise(resolve => steamMock.listen(0, '127.0.0.1', resolve));
const steamPort = steamMock.address().port;
const childEnv = { ...process.env, API_PORT: String(apiPort), WEB_ORIGIN: webOrigin,
  REDIS_URL: e2eRedisUrl.toString() };
const apiProcess = spawn(process.execPath, ['apps/api/dist/main.js'], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
const python = join('apps', 'intelligence', '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const workerProcess = spawn(python, ['-m', 'marketrift_intelligence.worker'], {
  env: { ...childEnv, ANALYSIS_PROVIDER: 'test', MARKETRIFT_TEST_MODE: '1',
    STEAM_REVIEW_TEST_BASE_URL: `http://127.0.0.1:${steamPort}`,
    WEB_PAGE_TEST_BASE_URL: `http://127.0.0.1:${steamPort}`,
    GITHUB_DISCUSSIONS_TEST_BASE_URL: `http://127.0.0.1:${steamPort}`,
    GITHUB_DISCUSSIONS_TOKEN: 'e2e-read-only-placeholder' },
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
function launchScheduler() {
  const schedulerProcess = spawn(process.execPath, ['apps/api/dist/page-scheduler-main.js'], {
    env: { ...childEnv, MARKETRIFT_TEST_MODE: '1', PAGE_SCHEDULER_TEST_POLL_MS: '200',
      PAGE_SCHEDULER_TEST_TENANT_ID: cleanupTenants[0] },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  schedulerProcess.stderr.on('data', chunk => { errors += String(chunk); });
  schedulerProcess.on('error', error => { errors += String(error); });
  children.push(schedulerProcess);
  return schedulerProcess;
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
async function waitForSourceRun(browser, id) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = await browser.call('source-runs');
    const run = result.body.find(item => item.id === id);
    if (run?.status === 'succeeded') return run;
    if (run?.status === 'failed') throw new Error(`Source sync failed: ${JSON.stringify(run)}`);
    await delay(200);
  }
  throw new Error(`Source sync did not complete: ${errors}`);
}
async function waitForPageRun(browser, id) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = await browser.call('page-sources');
    const run = result.body.runs.find(item => item.id === id);
    if (run?.status === 'succeeded') return result.body;
    if (run?.status === 'failed') throw new Error(`Page check failed: ${JSON.stringify(run)}`);
    await delay(200);
  }
  throw new Error(`Page check did not complete: ${errors}`);
}
async function waitForScheduledPageRun(browser, sourceId, count) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = await browser.call('page-sources');
    const runs = result.body.runs.filter(item => item.source_id === sourceId && item.trigger_kind === 'scheduled');
    if (runs.some(item => item.status === 'failed')) throw new Error(`Scheduled check failed: ${JSON.stringify(runs)}`);
    if (runs.filter(item => item.status === 'succeeded').length >= count) return result.body;
    await delay(200);
  }
  throw new Error(`Scheduled page check did not complete: ${errors}`);
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

  const discussionSource = await a.call('sources/github-discussions', { method: 'POST',
    body: JSON.stringify({ product_id: competitor.body.id, repository: 'Example/Repo' }) });
  assert.equal(discussionSource.status, 201, JSON.stringify(discussionSource.body));
  assert.equal(discussionSource.body.url, 'https://github.com/example/repo');
  assert.equal((await b.call('sources/github-discussions', { method: 'POST',
    body: JSON.stringify({ product_id: competitor.body.id, repository: 'Example/Repo' }) })).status, 404);
  assert.equal((await analyst.call('sources/github-discussions', { method: 'POST',
    body: JSON.stringify({ product_id: competitor.body.id, repository: 'Example/Repo' }) })).status, 403);
  assert.equal((await viewer.call(`sources/${discussionSource.body.id}/sync`, { method: 'POST',
    body: JSON.stringify({ max_pages: 1, max_items: 1 }) })).status, 403);
  assert.equal((await b.call(`sources/${discussionSource.body.id}/sync`, { method: 'POST',
    body: JSON.stringify({ max_pages: 1, max_items: 1 }) })).status, 404);
  async function syncDiscussions(maxItems = 1) {
    const queued = await analyst.call(`sources/${discussionSource.body.id}/sync`, { method: 'POST',
      body: JSON.stringify({ max_pages: 2, max_items: maxItems }) });
    assert.equal(queued.status, 200, JSON.stringify(queued.body));
    return waitForSourceRun(analyst, queued.body.id);
  }
  const discussionFirst = await syncDiscussions();
  assert.equal(discussionFirst.documents_new, 1);
  assert.equal(discussionFirst.scan_complete, false);
  const discussionSecond = await syncDiscussions();
  assert.equal(discussionSecond.documents_new, 1);
  assert.equal(discussionSecond.scan_complete, true);
  const originalDiscussion = (await a.call('documents')).body.find(item => item.external_key === 'D_1');
  assert.equal(originalDiscussion.document_type, 'github_discussion');
  assert.equal(originalDiscussion.source_body, discussionBody);
  assert.equal(originalDiscussion.discussion_category, 'Ideas');
  assert.equal(originalDiscussion.analysis_status, null);
  assert.equal((await a.call('documents')).body.find(item => item.external_key === 'D_2').discussion_relevance, 'announcement');
  assert.equal((await b.call('documents')).body.length, 0);
  discussionBody = 'Edited integration failure when the account name contains spaces.';
  discussionUpdated = '2026-09-24T13:00:00Z';
  const discussionThird = await syncDiscussions(2);
  assert.equal(discussionThird.documents_new, 0);
  assert.equal(discussionThird.documents_updated, 1);
  assert.equal((await a.call('documents')).body.find(item => item.external_key === 'D_1').source_body, discussionBody);
  assert.equal((await a.call('documents')).body.filter(item => item.document_type === 'github_discussion').length, 2);
  assert.equal(discussionRequests.length, 4);
  assert.equal(discussionRequests.every(item => item.authorized), true);
  assert.deepEqual(discussionRequests.map(item => item.variables.after), [null, 'cursor-one', null, 'cursor-one']);

  const steamSource = await a.call('sources/steam-reviews', { method: 'POST',
    body: JSON.stringify({ product_id: competitor.body.id, app: '620' }) });
  assert.equal(steamSource.status, 201, JSON.stringify(steamSource.body));
  assert.equal(steamSource.body.url, 'https://store.steampowered.com/app/620/');
  assert.equal((await b.call('sources/steam-reviews', { method: 'POST',
    body: JSON.stringify({ product_id: competitor.body.id, app: '620' }) })).status, 404);
  assert.equal((await analyst.call('sources/steam-reviews', { method: 'POST',
    body: JSON.stringify({ product_id: competitor.body.id, app: '620' }) })).status, 403);
  assert.equal((await viewer.call(`sources/${steamSource.body.id}/sync`, { method: 'POST',
    body: JSON.stringify({ max_pages: 1, max_items: 1 }) })).status, 403);
  assert.equal((await b.call(`sources/${steamSource.body.id}/sync`, { method: 'POST',
    body: JSON.stringify({ max_pages: 1, max_items: 1 }) })).status, 404);
  async function syncSteam() {
    const queued = await analyst.call(`sources/${steamSource.body.id}/sync`, { method: 'POST',
      body: JSON.stringify({ max_pages: 1, max_items: 1 }) });
    assert.equal(queued.status, 200, JSON.stringify(queued.body));
    return waitForSourceRun(analyst, queued.body.id);
  }
  const steamFirst = await syncSteam();
  assert.equal(steamFirst.documents_seen, 1);
  assert.equal(steamFirst.documents_new, 1);
  assert.equal(steamFirst.documents_updated, 0);
  const steamDocuments = (await a.call('documents')).body.filter(item => item.document_type === 'steam_review');
  assert.equal(steamDocuments.length, 1);
  assert.equal(steamDocuments[0].product_name, 'Competitor');
  assert.equal(steamDocuments[0].external_key, '901001');
  assert.equal(steamDocuments[0].review_voted_up, false);
  assert.equal(steamDocuments[0].synthetic, false);
  assert.equal(steamDocuments[0].source_url_kind, 'product_reviews');
  assert.equal(steamDocuments[0].analysis_status, null);
  assert.equal(JSON.stringify(steamDocuments[0]).includes('must-not-be-stored'), false);
  assert.equal((await b.call('documents')).body.length, 0);
  const steamSecond = await syncSteam();
  assert.equal(steamSecond.documents_new, 0);
  assert.equal(steamSecond.documents_updated, 0);
  assert.equal((await a.call('documents')).body.filter(item => item.document_type === 'steam_review').length, 1);
  steamBody = 'Gostei muito da facilidade de uso.';
  steamUpdated += 3600;
  steamVotedUp = true;
  const steamThird = await syncSteam();
  assert.equal(steamThird.documents_new, 0);
  assert.equal(steamThird.documents_updated, 1);
  const steamChanged = (await a.call('documents')).body.find(item => item.id === steamDocuments[0].id);
  assert.equal(steamChanged.body, steamBody);
  assert.equal(steamChanged.review_voted_up, true);
  assert.equal(steamChanged.analysis_status, null);
  assert.equal(steamRequests.length, 3);
  assert.equal(steamRequests[0].searchParams.get('filter'), 'recent');
  assert.equal(steamRequests[1].searchParams.get('filter'), 'updated');
  assert.equal(steamRequests[2].searchParams.get('filter'), 'updated');
  assert.equal(steamRequests.every(url => url.searchParams.get('num_per_page') === '1'), true);
  assert.equal((await b.call(`documents/${steamChanged.id}/analyze`, { method: 'POST' })).status, 404);
  assert.equal((await viewer.call(`documents/${steamChanged.id}/analyze`, { method: 'POST' })).status, 403);
  assert.equal((await analyst.call(`documents/${steamChanged.id}/analyze`, { method: 'POST' })).body.status, 'queued');
  const steamAnalyzed = await waitForAnalysis(a, steamChanged.id);
  assert.deepEqual(steamAnalyzed.issues, []);
  assert.equal(steamAnalyzed.analysis_model, 'controlled-test-fixture-v1');

  const pageSource = await a.call('page-sources', { method: 'POST', body: JSON.stringify({
    product_id: competitor.body.id, source_type: 'pricing_page',
    url: 'https://example.com/pricing', check_interval_minutes: 1440,
  }) });
  assert.equal(pageSource.status, 201, JSON.stringify(pageSource.body));
  assert.equal((await b.call('page-sources')).body.sources.length, 0);
  assert.equal((await b.call('page-sources', { method: 'POST', body: JSON.stringify({
    product_id: competitor.body.id, source_type: 'pricing_page',
    url: 'https://example.com/other', check_interval_minutes: 1440,
  }) })).status, 404);
  assert.equal((await analyst.call('page-sources', { method: 'POST', body: JSON.stringify({
    product_id: competitor.body.id, source_type: 'pricing_page',
    url: 'https://example.com/other', check_interval_minutes: 1440,
  }) })).status, 403);
  assert.equal((await viewer.call(`page-sources/${pageSource.body.id}/check`, { method: 'POST' })).status, 403);
  assert.equal((await b.call(`page-sources/${pageSource.body.id}/check`, { method: 'POST' })).status, 404);
  async function checkPage() {
    const queued = await analyst.call(`page-sources/${pageSource.body.id}/check`, { method: 'POST' });
    assert.equal(queued.status, 200, JSON.stringify(queued.body));
    return waitForPageRun(analyst, queued.body.id);
  }
  const pageFirst = await checkPage();
  assert.equal(pageFirst.snapshots.filter(item => item.source_id === pageSource.body.id).length, 1);
  assert.equal(pageFirst.changes.filter(item => item.source_id === pageSource.body.id).length, 0);
  const tooSoon = await analyst.call(`page-sources/${pageSource.body.id}/check`, { method: 'POST' });
  assert.equal(tooSoon.status, 409);
  assert.match(tooSoon.body.message, /Aguarde o intervalo mínimo.*Tente novamente após/);
  async function clearPageCooldown() {
    const client = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL });
    try {
      await client.connect();
      await client.query("UPDATE marketrift.source_runs SET finished_at = now() - interval '2 minutes' "
        + "WHERE tenant_id = $1 AND source_id = $2 AND run_kind = 'web_page'",
      [registeredA.body.tenant_id, pageSource.body.id]);
    } finally { await client.end(); }
  }
  await clearPageCooldown();
  const pageSecond = await checkPage();
  assert.equal(pageSecond.snapshots.filter(item => item.source_id === pageSource.body.id).length, 1);
  pagePrice = '12';
  await clearPageCooldown();
  const pageThird = await checkPage();
  assert.equal(pageThird.snapshots.filter(item => item.source_id === pageSource.body.id).length, 2);
  const priceChange = pageThird.changes.find(item => item.source_id === pageSource.body.id);
  assert.equal(priceChange.change_details[0].percent_change, '20.00');
  assert.equal(pageRequests.filter(path => path === '/web-page/pricing').length, 3);
  assert.equal((await b.call('page-sources')).body.changes.length, 0);

  const legacySource = await a.call('page-sources', { method: 'POST', body: JSON.stringify({
    product_id: competitor.body.id, source_type: 'release_notes',
    url: 'https://example.com/legacy', check_interval_minutes: 1440,
  }) });
  assert.equal(legacySource.status, 201);
  assert.equal((await a.call(`page-sources/${legacySource.body.id}/pause`, { method: 'POST' })).status, 200);
  const legacyDb = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL });
  try {
    await legacyDb.connect();
    const previousId = randomUUID(); const currentId = randomUUID();
    for (const [index, runId] of [previousId, currentId].entries()) {
      await legacyDb.query("INSERT INTO marketrift.source_runs "
        + "(id, tenant_id, source_id, status, run_kind, started_at, finished_at) "
        + "VALUES ($1, $2, $3, 'succeeded', 'web_page', now() - interval '2 minutes', now() - interval '2 minutes')",
      [runId, registeredA.body.tenant_id, legacySource.body.id]);
      const oldJson = { kind: 'release_notes', text: `Editorial article ${index}`, status: 'structured',
        excerpt: `Editorial article ${index}`, entries: [{ title: 'Editorial article', url: 'https://example.com/legacy' }] };
      await legacyDb.query("INSERT INTO marketrift.source_snapshots "
        + "(tenant_id, source_id, run_id, source_url, storage_key, content_sha256, "
        + "version_no, final_url, normalized_text, extracted) "
        + "VALUES ($1, $2, $3, 'https://example.com/legacy', $4, $5, $6, "
        + "'https://example.com/legacy', $7, $8::jsonb)",
      [registeredA.body.tenant_id, legacySource.body.id, runId, `legacy:${index}`, String(index).repeat(64),
        index + 1, oldJson.text, JSON.stringify(oldJson)]);
    }
    const ids = await legacyDb.query("SELECT id FROM marketrift.source_snapshots WHERE tenant_id = $1 "
      + 'AND source_id = $2 ORDER BY version_no', [registeredA.body.tenant_id, legacySource.body.id]);
    await legacyDb.query("INSERT INTO marketrift.page_changes "
      + "(tenant_id, source_id, previous_snapshot_id, current_snapshot_id, change_details) "
      + "VALUES ($1, $2, $3, $4, '[{\"kind\":\"entry_appeared\"}]'::jsonb)",
    [registeredA.body.tenant_id, legacySource.body.id, ids.rows[0].id, ids.rows[1].id]);
  } finally { await legacyDb.end(); }
  const oldApi = (await a.call('page-sources')).body;
  const oldSnapshot = oldApi.snapshots.find(item => item.source_id === legacySource.body.id);
  assert.equal(oldSnapshot.interpretation_status, 'needs_review');
  assert.equal(oldSnapshot.extracted.entries, undefined);
  assert.equal(oldApi.changes.find(item => item.source_id === legacySource.body.id).change_details[0].kind,
    'legacy_interpretation_requires_review');

  const autoSource = await a.call('page-sources', { method: 'POST', body: JSON.stringify({
    product_id: competitor.body.id, source_type: 'release_notes',
    url: 'https://example.com/changelog', check_interval_minutes: 60,
  }) });
  assert.equal(autoSource.status, 201, JSON.stringify(autoSource.body));
  assert.equal(autoSource.body.monitoring_enabled, true);
  assert.equal((await viewer.call(`page-sources/${autoSource.body.id}/pause`, { method: 'POST' })).status, 403);
  assert.equal((await analyst.call(`page-sources/${autoSource.body.id}/pause`, { method: 'POST' })).status, 403);
  assert.equal((await b.call(`page-sources/${autoSource.body.id}/pause`, { method: 'POST' })).status, 404);
  const schedulerA = launchScheduler();
  const schedulerB = launchScheduler();
  const scheduledFirst = await waitForScheduledPageRun(a, autoSource.body.id, 1);
  assert.equal(scheduledFirst.runs.filter(item => item.source_id === autoSource.body.id).length, 1);
  assert.equal(scheduledFirst.snapshots.find(item => item.source_id === autoSource.body.id).interpretation_status, 'confirmed');
  assert.equal((await b.call('page-sources')).body.sources.length, 0);
  await delay(800);
  assert.equal((await a.call('page-sources')).body.runs.filter(item => item.source_id === autoSource.body.id).length, 1);
  schedulerA.kill(); schedulerB.kill();
  async function advanceScheduledClock() {
    const client = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL });
    try {
      await client.connect();
      await client.query("UPDATE marketrift.source_runs SET started_at = now() - interval '2 minutes', "
        + "finished_at = now() - interval '2 minutes' WHERE tenant_id = $1 AND source_id = $2 "
        + "AND run_kind = 'web_page' AND status = 'succeeded'",
      [registeredA.body.tenant_id, autoSource.body.id]);
      await client.query("UPDATE marketrift.sources SET next_check_at = now() - interval '1 second' "
        + 'WHERE tenant_id = $1 AND id = $2', [registeredA.body.tenant_id, autoSource.body.id]);
    } finally { await client.end(); }
  }
  await advanceScheduledClock();
  launchScheduler();
  const scheduledSecond = await waitForScheduledPageRun(a, autoSource.body.id, 2);
  assert.equal(scheduledSecond.snapshots.filter(item => item.source_id === autoSource.body.id).length, 1);
  assert.equal(scheduledSecond.runs.filter(item => item.source_id === autoSource.body.id).length, 2);

  const paused = await admin.call(`page-sources/${autoSource.body.id}/pause`, { method: 'POST' });
  assert.equal(paused.status, 200);
  assert.equal(paused.body.monitoring_enabled, false);
  await delay(800);
  assert.equal((await a.call('page-sources')).body.runs.filter(item => item.source_id === autoSource.body.id).length, 2);

  const editorialSource = await a.call('page-sources', { method: 'POST', body: JSON.stringify({
    product_id: competitor.body.id, source_type: 'release_notes',
    url: 'https://example.com/', check_interval_minutes: 60,
  }) });
  assert.equal(editorialSource.status, 201);
  const editorialResult = await waitForScheduledPageRun(a, editorialSource.body.id, 1);
  const editorialSnapshot = editorialResult.snapshots.find(item => item.source_id === editorialSource.body.id);
  assert.equal(editorialSnapshot.interpretation_status, 'unconfirmed');
  assert.equal(editorialSnapshot.interpretation_reason, 'release_context_missing');
  assert.deepEqual(editorialSnapshot.extracted.entries, []);

  await advanceScheduledClock();
  releaseVersion = 2;
  const resumed = await a.call(`page-sources/${autoSource.body.id}/resume`, { method: 'POST' });
  assert.equal(resumed.status, 200);
  assert.equal(resumed.body.monitoring_enabled, true);
  const scheduledThird = await waitForScheduledPageRun(a, autoSource.body.id, 3);
  assert.equal(scheduledThird.snapshots.filter(item => item.source_id === autoSource.body.id).length, 2);
  const releaseChange = scheduledThird.changes.find(item => item.source_id === autoSource.body.id);
  assert(releaseChange.change_details.some(item => item.kind === 'entry_appeared'));
  assert.equal(pageRequests.filter(path => path === '/web-page/changelog').length, 3);

  const flakySource = await a.call('page-sources', { method: 'POST', body: JSON.stringify({
    product_id: competitor.body.id, source_type: 'release_notes',
    url: 'https://example.com/changelog-flaky', check_interval_minutes: 60,
  }) });
  assert.equal(flakySource.status, 201);
  let flakyFailed;
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = (await a.call('page-sources')).body;
    const failed = result.runs.find(item => item.source_id === flakySource.body.id && item.status === 'failed');
    if (failed) { flakyFailed = { run: failed, source: result.sources.find(item => item.id === flakySource.body.id) }; break; }
    await delay(200);
  }
  assert.equal(flakyFailed?.run.error_code, 'rate_limited');
  assert(new Date(flakyFailed.source.next_check_at).getTime() > Date.now() + 4 * 60_000);
  assert.equal(flakyAttempts, 1);
  const retryDb = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL });
  try {
    await retryDb.connect();
    await retryDb.query("UPDATE marketrift.source_runs SET started_at = now() - interval '2 minutes', "
      + "finished_at = CASE WHEN finished_at IS NOT NULL THEN now() - interval '2 minutes' ELSE NULL END, "
      + "retry_after_at = CASE WHEN retry_after_at IS NOT NULL THEN now() - interval '2 minutes' ELSE NULL END "
      + "WHERE tenant_id = $1 AND run_kind = 'web_page'",
    [registeredA.body.tenant_id]);
    await retryDb.query("UPDATE marketrift.sources SET next_check_at = now() - interval '1 second' "
      + 'WHERE tenant_id = $1 AND id = $2', [registeredA.body.tenant_id, flakySource.body.id]);
  } finally { await retryDb.end(); }
  let flakyRecovered;
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = (await a.call('page-sources')).body;
    const runs = result.runs.filter(item => item.source_id === flakySource.body.id);
    if (runs.length === 2 && runs.some(item => item.status === 'succeeded')) { flakyRecovered = result; break; }
    await delay(200);
  }
  assert(flakyRecovered, 'Transient source did not retry after its due time');
  assert.equal(flakyAttempts, 2);
  assert.equal(flakyRecovered.sources.find(item => item.id === flakySource.body.id).consecutive_failures, 0);

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
  console.log('E2E passed: sessions, RBAC, CSV, Steam, GitHub Discussions GraphQL, pages, schedulers, retries, conservative interpretation and tenant isolation');
} catch (error) {
  console.error(error, errors);
  process.exitCode = 1;
} finally {
  for (const child of children) child.kill();
  steamMock.close();
  if (cleanupTenants.length) {
    const admin = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL });
    try {
      await admin.connect();
      await admin.query('BEGIN');
      const users = await admin.query('SELECT id FROM marketrift.users WHERE email = ANY($1::text[])', [cleanupEmails]);
      await admin.query('DELETE FROM marketrift.member_invitations WHERE tenant_id = ANY($1::uuid[])', [cleanupTenants]);
      await admin.query('DELETE FROM marketrift.browser_sessions WHERE tenant_id = ANY($1::uuid[])', [cleanupTenants]);
      for (const table of ['insights', 'document_analyses', 'import_rows', 'page_changes', 'source_snapshots', 'source_runs', 'documents', 'imports', 'sources', 'products', 'memberships']) {
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
