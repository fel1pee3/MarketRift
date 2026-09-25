import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { join } from 'node:path';
import pg from 'pg';

const apiPort = Number(process.env.E2E_API_PORT ?? 3211);
const webPort = Number(process.env.E2E_WEB_PORT ?? 3210);
const embeddingPort = Number(process.env.E2E_EMBEDDING_PORT ?? 3212);
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
let g2Body = 'The invoice export failed.';
let g2Updated = '2026-09-02T12:00:00Z';
let g2Public = true;
const g2Requests = [];
const steamMock = createServer((request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  if (url.pathname === '/api/2018-01-01/syndication/reviews') {
    if (url.searchParams.get('filter[product_id]') === 'forbidden') {
      response.writeHead(403, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: 'permission not granted' })); return;
    }
    g2Requests.push({ page: url.searchParams.get('page[number]'),
      product: url.searchParams.get('filter[product_id]'),
      credential: url.searchParams.get('api_token') === 'e2e-g2-placeholder' });
    const page = Number(url.searchParams.get('page[number]'));
    const id = page === 1 ? 'g2-1' : 'g2-2';
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ data: [{ id, type: 'survey_responses', attributes: {
      is_public: page === 1 ? g2Public : true,
      title: 'Synthetic review for connector test',
      url: `https://www.g2.com/products/example/reviews/${id}`,
      published_at: '2026-09-01T12:00:00Z',
      user_updated_at: page === 1 ? g2Updated : '2026-09-02T12:00:00Z',
      star_rating: 3.5, answers: { hate: { value: page === 1 ? g2Body : 'The search failed.' } },
      user: { name: 'must-not-be-stored' },
    } }], links: { next: page === 1 ? 'https://data.g2.com/unsafe?api_token=do-not-follow' : null } }));
    return;
  }
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
  REDIS_URL: e2eRedisUrl.toString(), EMBEDDING_PROVIDER: 'controlled',
  EMBEDDING_INTERNAL_TOKEN: 'e2e-internal-placeholder',
  EMBEDDING_INTERNAL_URL: `http://127.0.0.1:${embeddingPort}` };
const apiProcess = spawn(process.execPath, ['apps/api/dist/main.js'], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
const python = join('apps', 'intelligence', '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const workerProcess = spawn(python, ['-m', 'marketrift_intelligence.worker'], {
  env: { ...childEnv, ANALYSIS_PROVIDER: 'test', MARKETRIFT_TEST_MODE: '1',
    STEAM_REVIEW_TEST_BASE_URL: `http://127.0.0.1:${steamPort}`,
    WEB_PAGE_TEST_BASE_URL: `http://127.0.0.1:${steamPort}`,
    GITHUB_DISCUSSIONS_TEST_BASE_URL: `http://127.0.0.1:${steamPort}`,
    GITHUB_DISCUSSIONS_TOKEN: 'e2e-read-only-placeholder',
    G2_TEST_BASE_URL: `http://127.0.0.1:${steamPort}`,
    G2_SYNDICATION_TOKEN: 'e2e-g2-placeholder' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const embeddingProcess = spawn(python, ['-m', 'uvicorn', 'marketrift_intelligence.http:app',
  '--host', '127.0.0.1', '--port', String(embeddingPort)], {
  env: childEnv, stdio: ['ignore', 'pipe', 'pipe'],
});
const webProcess = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', 'apps/web', '-p', String(webPort)], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
const children = [apiProcess, workerProcess, embeddingProcess, webProcess];
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
    try { await Promise.all([fetch(`${apiBase}/me`), fetch(`http://127.0.0.1:${embeddingPort}/health`)]); return; }
    catch { await delay(100); }
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
async function waitForFailedSourceRun(browser, id) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = await browser.call('source-runs');
    const run = result.body.find(item => item.id === id);
    if (run?.status === 'failed') return run;
    await delay(200);
  }
  throw new Error(`Expected source failure did not arrive: ${errors}`);
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
  const partialEvidence = await viewer.call('evidence/search?source_type=github_discussion');
  assert.equal(partialEvidence.status, 200, JSON.stringify(partialEvidence.body));
  assert.equal(partialEvidence.body.counts[0].count, 1);
  assert(partialEvidence.body.partial_sources.some(item => item.source_id === discussionSource.body.id));
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

  const g2Registration = { product_id: competitor.body.id, g2_product_id: 'product-test-1',
    product_url: 'https://www.g2.com/products/example', environment: 'sandbox' };
  assert.equal((await analyst.call('sources/g2', { method: 'POST', body: JSON.stringify(g2Registration) })).status, 403);
  assert.equal((await b.call('sources/g2', { method: 'POST', body: JSON.stringify(g2Registration) })).status, 404);
  const g2Source = await a.call('sources/g2', { method: 'POST', body: JSON.stringify(g2Registration) });
  assert.equal(g2Source.status, 201, JSON.stringify(g2Source.body));
  assert.equal((await viewer.call(`sources/${g2Source.body.id}/sync`, { method: 'POST',
    body: JSON.stringify({ max_pages: 1, max_items: 1 }) })).status, 403);
  assert.equal((await b.call(`sources/${g2Source.body.id}/sync`, { method: 'POST',
    body: JSON.stringify({ max_pages: 1, max_items: 1 }) })).status, 404);
  async function syncG2(maxPages = 1, maxItems = 1) {
    const queued = await analyst.call(`sources/${g2Source.body.id}/sync`, { method: 'POST',
      body: JSON.stringify({ max_pages: maxPages, max_items: maxItems }) });
    assert.equal(queued.status, 200, JSON.stringify(queued.body));
    return waitForSourceRun(a, queued.body.id);
  }
  const g2First = await syncG2();
  assert.equal(g2First.documents_new, 1);
  assert.equal(g2First.scan_complete, false);
  const g2Second = await syncG2();
  assert.equal(g2Second.documents_new, 1);
  assert.equal(g2Second.scan_complete, true);
  const g2Before = (await a.call('documents')).body.find(item => item.external_key === 'g2-1');
  assert.equal(g2Before.document_type, 'g2_review');
  assert.equal(g2Before.review_data_status, 'sandbox_test');
  assert.equal(g2Before.synthetic, true);
  assert.equal(g2Before.analysis_status, null);
  assert.equal(g2Before.analysis_eligibility, 'g2_blocked');
  assert.equal((await a.call(`documents/${g2Before.id}/analyze-b2b`, { method: 'POST',
    body: JSON.stringify({ provider: 'test' }) })).status, 404);
  assert.equal((await a.call(`documents/${g2Before.id}/analyze`, { method: 'POST' })).status, 404);
  assert.equal(JSON.stringify(g2Before).includes('must-not-be-stored'), false);
  const g2Repeat = await syncG2(2, 2);
  assert.equal(g2Repeat.documents_new, 0);
  assert.equal(g2Repeat.documents_updated, 0);
  g2Body = 'The edited invoice export failed twice.';
  g2Updated = '2026-09-03T12:00:00Z';
  const g2Edited = await syncG2(2, 2);
  assert.equal(g2Edited.documents_updated, 1, JSON.stringify({ run: g2Edited, pages: g2Requests.map(item => item.page) }));
  assert.equal((await a.call('documents')).body.find(item => item.id === g2Before.id).body, g2Body);
  g2Public = false;
  await syncG2(2, 2);
  assert.equal((await a.call('documents')).body.some(item => item.id === g2Before.id), false);
  assert.equal(g2Requests.every(item => item.product === 'product-test-1' && item.credential), true);
  assert.deepEqual(g2Requests.map(item => item.page), ['1', '2', '1', '2', '1', '2', '1', '2']);
  assert.equal((await b.call('evidence/search?source_type=g2_review')).body.total, 0);
  assert.equal((await a.call('evidence/search?source_type=g2_review')).body.total, 1);
  assert.equal((await viewer.call(`sources/${g2Source.body.id}/revoke-review-rights`, { method: 'POST' })).status, 403);
  assert.equal((await b.call(`sources/${g2Source.body.id}/revoke-review-rights`, { method: 'POST' })).status, 404);
  assert.equal((await a.call(`sources/${g2Source.body.id}/revoke-review-rights`, { method: 'POST' })).body.status, 'purged');
  assert.equal((await a.call('evidence/search?source_type=g2_review')).body.total, 0);
  const deniedG2 = await a.call('sources/g2', { method: 'POST', body: JSON.stringify({
    product_id: competitor.body.id, g2_product_id: 'forbidden',
    product_url: 'https://www.g2.com/products/forbidden', environment: 'sandbox',
  }) });
  assert.equal(deniedG2.status, 201);
  const deniedRun = await analyst.call(`sources/${deniedG2.body.id}/sync`, { method: 'POST',
    body: JSON.stringify({ max_pages: 1, max_items: 5 }) });
  assert.equal(deniedRun.status, 200);
  assert.equal((await waitForFailedSourceRun(a, deniedRun.body.id)).error_code, 'scope_or_product_access_denied');
  assert.equal((await a.call('sources')).body.find(item => item.id === deniedG2.body.id).access_status, 'denied');

  const b2bFixture = { product_id: competitor.body.id, url: 'https://example.invalid/b2b-reviews',
    rights_reference: 'E2E synthetic fixture only', storage_permitted: true,
    external_ai_permitted: false, synthetic_only: true };
  assert.equal((await a.call('sources/b2b-csv', { method: 'POST', body: JSON.stringify({
    ...b2bFixture, url: 'https://192.0.2.1/reviews', synthetic_only: false,
  }) })).status, 400);
  assert.equal((await analyst.call('sources/b2b-csv', { method: 'POST', body: JSON.stringify(b2bFixture) })).status, 403);
  assert.equal((await b.call('sources/b2b-csv', { method: 'POST', body: JSON.stringify(b2bFixture) })).status, 404);
  const b2bSource = await a.call('sources/b2b-csv', { method: 'POST', body: JSON.stringify(b2bFixture) });
  assert.equal(b2bSource.status, 201, JSON.stringify(b2bSource.body));
  const b2bCsv = 'external_key,source_url,published_at,body,language,rating,synthetic\nb2b-test-1,https://example.invalid/reviews/1,2026-09-01T10:00:00Z,Exemplo sintético: a exportação de faturas falhou duas vezes.,,,true\n';
  async function importB2B(csv) {
    const body = new FormData(); body.set('source_id', b2bSource.body.id);
    body.set('file', new Blob([csv], { type: 'text/csv' }), 'test.csv');
    return analyst.call('imports/b2b-reviews', { method: 'POST', body });
  }
  assert.equal((await importB2B(b2bCsv.replace('true', 'false'))).status, 400);
  const b2bFirst = await importB2B(b2bCsv);
  assert.equal(b2bFirst.status, 201, JSON.stringify(b2bFirst.body));
  await waitForImport(a, b2bFirst.body.id);
  const b2bSecond = await importB2B(b2bCsv);
  assert.equal(b2bSecond.status, 201, JSON.stringify(b2bSecond.body));
  await waitForImport(a, b2bSecond.body.id);
  const b2bDocuments = (await a.call('documents')).body.filter(item => item.document_type === 'b2b_review');
  assert.equal(b2bDocuments.length, 1);
  assert.equal(b2bDocuments[0].review_data_status, 'synthetic_fixture');
  assert.equal(b2bDocuments[0].review_rating, null);
  assert.equal(b2bDocuments[0].analysis_status, null);
  assert.equal(b2bDocuments[0].analysis_eligibility, 'controlled_test');
  assert.equal((await viewer.call(`documents/${b2bDocuments[0].id}/analyze-b2b`, { method: 'POST',
    body: JSON.stringify({ provider: 'test' }) })).status, 403);
  assert.equal((await b.call(`documents/${b2bDocuments[0].id}/analyze-b2b`, { method: 'POST',
    body: JSON.stringify({ provider: 'test' }) })).status, 404);
  assert.equal((await analyst.call(`documents/${b2bDocuments[0].id}/analyze-b2b`, { method: 'POST',
    body: JSON.stringify({ provider: 'openai', allow_paid: true, max_items: 1,
      model: 'gpt-5-nano', max_output_tokens: 128, budget_usd: 0.05 }) })).status, 403);
  assert.equal((await a.call(`sources/b2b-csv/${b2bSource.body.id}/ai-rights`, { method: 'POST',
    body: JSON.stringify({ provider: 'openai', rights_reference: 'synthetic-test-only',
      external_ai_permitted: true, rights_expires_at: '2030-01-01T00:00:00Z' }) })).status, 404);
  const b2bAnalysis = await analyst.call(`documents/${b2bDocuments[0].id}/analyze-b2b`, {
    method: 'POST', body: JSON.stringify({ provider: 'test' }),
  });
  assert.equal(b2bAnalysis.status, 200, JSON.stringify(b2bAnalysis.body));
  const completedB2B = await waitForAnalysis(a, b2bDocuments[0].id);
  assert.equal(completedB2B.analysis_model, 'controlled-test-fixture-v1');
  assert.equal(completedB2B.issues.length, 1);
  assert.ok(completedB2B.body.includes(completedB2B.issues[0].evidence_quote));
  assert.equal((await analyst.call(`documents/${b2bDocuments[0].id}/analyze-b2b`, {
    method: 'POST', body: JSON.stringify({ provider: 'test' }),
  })).body.status, 'completed');
  const b2bAfter = (await a.call('documents')).body.filter(item => item.id === b2bDocuments[0].id);
  assert.equal(b2bAfter.length, 1);
  assert.equal(b2bAfter[0].issues.length, 1);
  const b2bSignals = (await a.call('evidence/signals?source_type=b2b_review')).body;
  assert.ok(b2bSignals.review_buckets.some(item => item.synthetic && item.analyzed_reviews === 1));
  const b2bEvidence = (await a.call('evidence/search?source_type=b2b_review')).body.items;
  assert.equal(b2bEvidence.length, 1);
  assert.equal(b2bEvidence[0].analysis_status, 'completed');
  assert.equal(b2bEvidence[0].analysis_model, 'controlled-test-fixture-v1');
  assert.equal(b2bEvidence[0].issues.length, 1);
  assert.ok(completedB2B.body.includes(b2bEvidence[0].issues[0].evidence_quote));
  assert.equal((await viewer.call('evidence/reindex', { method: 'POST',
    body: JSON.stringify({ source_id: b2bSource.body.id }) })).status, 403);
  assert.equal((await b.call('evidence/reindex', { method: 'POST',
    body: JSON.stringify({ source_id: b2bSource.body.id }) })).status, 400);
  const question = { question: 'exportação faturas falhou', source_type: 'b2b_review' };
  let indexedAnswer;
  for (let attempt = 0; attempt < 80; attempt++) {
    indexedAnswer = await viewer.call('evidence/questions', { method: 'POST',
      body: JSON.stringify({ ...question, include_synthetic: true }) });
    if (indexedAnswer.body?.citations?.length) break;
    await delay(200);
  }
  assert.equal(indexedAnswer.status, 201, JSON.stringify(indexedAnswer.body));
  assert.equal(indexedAnswer.body.citations.length, 1, JSON.stringify(indexedAnswer.body));
  assert.equal(indexedAnswer.body.test_only, true);
  assert.equal(indexedAnswer.body.cost_usd, 0);
  assert.ok(completedB2B.body.includes(indexedAnswer.body.citations[0].quote));
  assert.ok(indexedAnswer.body.answer.includes(indexedAnswer.body.citations[0].id));
  const indexStatusA = await viewer.call('evidence/index-status');
  assert.equal(indexStatusA.status, 200);
  assert.equal(indexStatusA.body.model, 'controlled-hash-TESTE');
  assert.ok(indexStatusA.body.sources.some(item => item.source_id === b2bSource.body.id
    && item.state === 'complete' && item.ready_chunks === 1 && item.total_chunks === 1));
  const indexStatusB = await b.call('evidence/index-status');
  assert.equal(indexStatusB.status, 200);
  assert.ok(indexStatusB.body.sources.every(item => item.source_id !== b2bSource.body.id));
  console.log(`Controlled retrieval E2E latency: ${indexedAnswer.body.elapsed_ms} ms (test fixture, not a production SLA)`);
  const indexDb = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL });
  await indexDb.connect();
  try {
    const count = async () => Number((await indexDb.query(
      'SELECT count(*)::integer AS n FROM marketrift.evidence_chunks WHERE tenant_id = $1 AND source_id = $2',
      [registeredA.body.tenant_id, b2bSource.body.id])).rows[0].n);
    const beforeReplay = await count();
    assert.equal(beforeReplay, 1);
    assert.equal((await analyst.call('evidence/reindex', { method: 'POST',
      body: JSON.stringify({ source_id: b2bSource.body.id }) })).status, 201);
    for (let attempt = 0; attempt < 50; attempt++) { await delay(100); }
    assert.equal(await count(), beforeReplay);
    await indexDb.query('UPDATE marketrift.documents SET body = $1 WHERE id = $2 AND tenant_id = $3',
      ['Exemplo sintético: a integração falhou ao salvar.', b2bDocuments[0].id, registeredA.body.tenant_id]);
    assert.equal((await viewer.call('evidence/questions', { method: 'POST',
      body: JSON.stringify({ ...question, include_synthetic: true }) })).body.citations.length, 0);
    assert.equal((await analyst.call('evidence/reindex', { method: 'POST',
      body: JSON.stringify({ source_id: b2bSource.body.id }) })).status, 201);
    let changed;
    for (let attempt = 0; attempt < 80; attempt++) {
      changed = await viewer.call('evidence/questions', { method: 'POST',
        body: JSON.stringify({ question: 'integração falhou', source_type: 'b2b_review',
          include_synthetic: true }) });
      if (changed.body?.citations?.length) break;
      await delay(100);
    }
    assert.equal(changed.body.citations.length, 1, JSON.stringify(changed.body));
    assert.ok(changed.body.citations[0].quote.includes('integração falhou'));
    assert.equal(await count(), 1);
  } finally { await indexDb.end(); }
  const defaultAnswer = await viewer.call('evidence/questions', { method: 'POST', body: JSON.stringify(question) });
  assert.equal(defaultAnswer.body.citations.length, 0);
  assert.match(defaultAnswer.body.answer, /Não há evidência suficiente/);
  const sharedSource = await a.call('sources/b2b-csv', { method: 'POST',
    body: JSON.stringify({ ...b2bFixture, product_id: product.body.id }) });
  assert.equal(sharedSource.status, 201);
  const sharedCsv = new FormData(); sharedCsv.set('source_id', sharedSource.body.id);
  sharedCsv.set('file', new File([
    'external_key,source_url,published_at,body,language,rating,synthetic\n'
    + 'b2b-test-1,https://example.invalid/reviews/1,2026-09-01T10:00:00Z,Exemplo sintético: a integração falhou ao salvar.,,,true\n',
  ], 'shared.csv', { type: 'text/csv' }));
  const sharedImport = await analyst.call('imports/b2b-reviews', { method: 'POST', body: sharedCsv });
  assert.equal(sharedImport.status, 201);
  await waitForImport(a, sharedImport.body.id);
  let sharedAnswer;
  for (let attempt = 0; attempt < 80; attempt++) {
    sharedAnswer = await viewer.call('evidence/questions', { method: 'POST',
      body: JSON.stringify({ question: 'integração falhou', source_type: 'b2b_review',
        include_synthetic: true }) });
    if (sharedAnswer.body?.citations?.[0]?.ambiguous_association) break;
    await delay(100);
  }
  assert.equal(sharedAnswer.body.citations.length, 1);
  assert.equal(sharedAnswer.body.citations[0].ambiguous_association, true);
  assert.equal((await a.call(`sources/${sharedSource.body.id}/revoke-review-rights`, {
    method: 'POST' })).body.documents_removed, 1);
  assert.equal((await b.call('evidence/questions', { method: 'POST',
    body: JSON.stringify({ ...question, include_synthetic: true }) })).body.citations.length, 0);
  assert.equal((await viewer.call('evidence/questions', { method: 'POST',
    body: JSON.stringify({ ...question, product_id: registeredB.body.tenant_id,
      include_synthetic: true }) })).body.citations.length, 0);
  assert.equal((await fetch(`http://127.0.0.1:${embeddingPort}/internal/embeddings`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'segredo' }),
  })).status, 401);
  assert.equal((await b.call('evidence/search?source_type=b2b_review')).body.total, 0);
  assert.equal((await a.call('evidence/search?source_type=b2b_review')).body.total, 1);
  assert.equal((await analyst.call(`documents/${b2bDocuments[0].id}/analyze`, { method: 'POST' })).status, 404);
  assert.equal((await viewer.call(`sources/${b2bSource.body.id}/revoke-review-rights`, { method: 'POST' })).status, 403);
  assert.equal((await b.call(`sources/${b2bSource.body.id}/revoke-review-rights`, { method: 'POST' })).status, 404);
  assert.equal((await a.call(`sources/${b2bSource.body.id}/revoke-review-rights`, { method: 'POST' })).body.documents_removed, 1);
  const purgeDb = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL });
  await purgeDb.connect();
  try {
    assert.equal(Number((await purgeDb.query('SELECT count(*)::integer AS n FROM marketrift.evidence_chunks WHERE source_id = $1',
      [b2bSource.body.id])).rows[0].n), 0);
  } finally { await purgeDb.end(); }
  assert.equal((await viewer.call('evidence/questions', { method: 'POST',
    body: JSON.stringify({ ...question, include_synthetic: true }) })).body.citations.length, 0);
  assert.equal((await a.call('evidence/search?source_type=b2b_review')).body.total, 0);
  const realRightsSource = await a.call('sources/b2b-csv', { method: 'POST', body: JSON.stringify({
    product_id: competitor.body.id, url: 'https://authorized-vendor.io/reviews',
    rights_reference: 'E2E storage permission declaration', storage_permitted: true,
    external_ai_permitted: false, synthetic_only: false,
  }) });
  assert.equal(realRightsSource.status, 201, JSON.stringify(realRightsSource.body));
  const aiRightsPath = `sources/b2b-csv/${realRightsSource.body.id}/ai-rights`;
  const aiRights = { provider: 'openai', rights_reference: 'E2E external processing declaration',
    external_ai_permitted: true, rights_expires_at: '2030-01-01T00:00:00Z' };
  assert.equal((await viewer.call(aiRightsPath, { method: 'POST', body: JSON.stringify(aiRights) })).status, 403);
  assert.equal((await analyst.call(aiRightsPath, { method: 'POST', body: JSON.stringify(aiRights) })).status, 403);
  assert.equal((await b.call(aiRightsPath, { method: 'POST', body: JSON.stringify(aiRights) })).status, 404);
  assert.equal((await a.call(aiRightsPath, { method: 'POST', body: JSON.stringify({
    ...aiRights, rights_expires_at: '2020-01-01T00:00:00Z',
  }) })).status, 400);
  assert.equal((await a.call(aiRightsPath, { method: 'POST', body: JSON.stringify(aiRights) })).status, 200);
  assert.equal((await analyst.call(`sources/b2b-csv/${realRightsSource.body.id}/revoke-ai-rights`, {
    method: 'POST',
  })).status, 403);
  assert.equal((await a.call(`sources/b2b-csv/${realRightsSource.body.id}/revoke-ai-rights`, {
    method: 'POST',
  })).status, 200);
  assert.equal((await a.call('sources')).body.find(item => item.id === realRightsSource.body.id).external_ai_permitted, false);

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

  // Evidence queries count identities, not repeated imports or source associations.
  const sharedSteamSource = await a.call('sources/steam-reviews', { method: 'POST',
    body: JSON.stringify({ product_id: product.body.id, app: '620' }) });
  assert.equal(sharedSteamSource.status, 201);
  const evidenceDb = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL });
  try {
    await evidenceDb.connect();
    await evidenceDb.query(`INSERT INTO marketrift.documents
      (tenant_id, source_id, document_type, external_key, source_url, source_url_kind,
       body, published_at, source_created_at, source_updated_at, steam_app_id,
       review_language, review_voted_up, synthetic)
      SELECT tenant_id, $1, document_type, external_key, source_url, source_url_kind,
       body, published_at, source_created_at, source_updated_at, steam_app_id,
       review_language, review_voted_up, synthetic
      FROM marketrift.documents WHERE id = $2`, [sharedSteamSource.body.id, steamChanged.id]);
  } finally { await evidenceDb.end(); }

  const anonymousEvidence = await new Browser().call('evidence/search');
  assert.equal(anonymousEvidence.status, 401);
  for (const invalid of ['source_type=other', 'limit=51', 'offset=-1',
    'from=2026-09-03&to=2026-09-01', `product_id=${encodeURIComponent('bad')}`]) {
    assert.equal((await viewer.call(`evidence/search?${invalid}`)).status, 400);
  }
  assert.equal((await viewer.call('evidence/signals?q=suporte')).status, 400);
  const allEvidence = await viewer.call('evidence/search?limit=50');
  assert.equal(allEvidence.status, 200, JSON.stringify(allEvidence.body));
  assert.equal((await a.call('evidence/search')).status, 200);
  assert.equal((await admin.call('evidence/search')).status, 200);
  assert.equal((await analyst.call('evidence/search')).status, 200);
  assert.equal(allEvidence.body.counts.find(item => item.source_type === 'csv_review').count, 2);
  assert.equal(allEvidence.body.counts.find(item => item.source_type === 'steam_review').count, 1);
  assert.equal(allEvidence.body.counts.find(item => item.source_type === 'github_discussion').count, 2);
  assert.equal(allEvidence.body.ambiguous_total, 1);
  const sharedReview = allEvidence.body.items.find(item => item.source_type === 'steam_review');
  assert.equal(sharedReview.association_count, 2);
  assert.equal(sharedReview.duplicate_rows, 2);
  assert.equal((await viewer.call(`evidence/search?product_id=${product.body.id}&source_type=steam_review`)).body.total, 1);
  assert.equal((await viewer.call('evidence/search?source_type=steam_review&limit=1&offset=1')).body.items.length, 0);
  const filteredEvidence = await viewer.call('evidence/search?from=2026-09-01&to=2026-09-02&q=facilidade');
  assert.equal(filteredEvidence.status, 200);
  assert.equal(filteredEvidence.body.counts.find(item => item.source_type === 'csv_review').count, 1);
  assert.equal(filteredEvidence.body.counts.some(item => item.source_type === 'pricing_page'), false);

  const signalResponse = await analyst.call('evidence/signals');
  assert.equal(signalResponse.status, 200, JSON.stringify(signalResponse.body));
  const syntheticCsv = signalResponse.body.review_buckets.find(item => item.source_type === 'csv_review' && item.synthetic);
  assert.deepEqual([syntheticCsv.total_reviews, syntheticCsv.analyzed_reviews, syntheticCsv.documents_without_analysis], [2, 2, 0]);
  assert.equal(signalResponse.body.categories.find(item => item.category === 'support').documents_with_problem, 1);
  assert.equal(signalResponse.body.categories.find(item => item.category === 'price').documents_with_problem, 1);
  const realSteam = signalResponse.body.review_buckets.find(item => item.source_type === 'steam_review' && !item.synthetic);
  assert.deepEqual([realSteam.total_reviews, realSteam.analyzed_reviews, realSteam.documents_without_analysis], [1, 0, 1]);
  assert.equal(signalResponse.body.categories.some(item => item.source_type === 'steam_review'), false);
  assert.equal(signalResponse.body.page_events.filter(item => item.detail.kind === 'price_observed').length, 1);
  assert.equal(signalResponse.body.page_events.filter(item => item.detail.kind === 'entry_appeared').length, 1);
  assert.equal(signalResponse.body.page_events.some(item => item.source_type === 'release_notes'
    && item.source_url === legacySource.body.url), false);
  assert.equal(signalResponse.body.page_events.some(item => item.source_type === 'release_notes'
    && item.source_url === editorialSource.body.url), false);
  assert.equal((await analyst.call('evidence/signals?source_type=pricing_page')).body.page_events.length, 1);

  const foreignProduct = await b.call('products', { method: 'POST',
    body: JSON.stringify({ name: 'Foreign Test Product', kind: 'competitor' }) });
  const foreignSource = await b.call('sources', { method: 'POST',
    body: JSON.stringify({ product_id: foreignProduct.body.id, url: 'https://example.invalid/foreign' }) });
  assert.equal(foreignSource.status, 201);
  const foreignCsv = `external_key,source_url,published_at,body,synthetic\nforeign-${suffix},https://example.invalid/foreign/${suffix},2026-09-01T10:00:00Z,Foreign tenant only.,true\n`;
  const foreignForm = new FormData();
  foreignForm.append('source_id', foreignSource.body.id);
  foreignForm.append('file', new Blob([foreignCsv], { type: 'text/csv' }), 'foreign.csv');
  const foreignImport = await b.call('imports/reviews', { method: 'POST', body: foreignForm });
  assert.equal(foreignImport.status, 201);
  await waitForImport(b, foreignImport.body.id);
  const foreignQuestion = { question: 'Foreign tenant only', source_type: 'review',
    product_id: foreignProduct.body.id, include_synthetic: true };
  let foreignAnswer;
  for (let attempt = 0; attempt < 80; attempt++) {
    foreignAnswer = await b.call('evidence/questions', { method: 'POST', body: JSON.stringify(foreignQuestion) });
    if (foreignAnswer.body?.citations?.length) break;
    await delay(100);
  }
  assert.equal(foreignAnswer.body.citations.length, 1);
  assert.equal((await a.call('evidence/questions', { method: 'POST',
    body: JSON.stringify(foreignQuestion) })).body.citations.length, 0);
  assert.equal((await b.call('evidence/search')).body.total, 1);
  assert.equal((await a.call('evidence/search?q=Foreign%20tenant%20only')).body.total, 0);
  assert.equal((await b.call(`evidence/search?product_id=${competitor.body.id}`)).body.total, 0);
  assert.equal((await b.call('evidence/signals')).body.page_events.length, 0);

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
  assert.equal((await analyst.call('evidence/questions', { method: 'POST',
    body: JSON.stringify(foreignQuestion) })).body.citations.length, 1);
  assert.equal((await analyst.call('auth/switch-tenant', { method: 'POST', body: JSON.stringify({ tenant_id: randomUUID() }) })).status, 403);
  const switched = await analyst.call('auth/switch-tenant', { method: 'POST', body: JSON.stringify({ tenant_id: registeredA.body.tenant_id }) });
  assert.equal(switched.status, 200, JSON.stringify(switched.body));
  assert.equal(switched.body.role, 'analyst');
  assert.equal((await analyst.call('documents')).body.filter(document => document.external_key === externalKey).length, 1);
  assert.equal((await analyst.call('evidence/questions', { method: 'POST',
    body: JSON.stringify(foreignQuestion) })).body.citations.length, 0);

  assert.equal((await viewer.call('auth/logout', { method: 'POST', withoutCsrf: true })).status, 403);
  assert.equal((await viewer.call('auth/logout', { method: 'POST' })).status, 204);
  assert.equal((await viewer.call('auth/session')).status, 401);
  assert.equal((await viewer.call('evidence/search')).status, 401);
  const relogin = await viewer.call('auth/login', { method: 'POST', body: JSON.stringify({ email: viewerEmail, password }) });
  assert.equal(relogin.status, 200);
  assert.equal((await viewer.call('auth/session')).body.role, 'viewer');
  assert.equal((await a.call(`members/${adminId}`, { method: 'DELETE' })).status, 204);
  assert.equal((await admin.call('auth/session')).status, 401);
  assert.equal((await admin.call('evidence/questions', { method: 'POST',
    body: JSON.stringify(foreignQuestion) })).status, 401);
  console.log('E2E passed: sessions, RBAC, CSV, B2B fixture, G2 controlled API, Steam, GitHub Discussions GraphQL, pages, evidence, signals, schedulers, retries and tenant isolation');
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
      for (const table of ['evidence_chunks', 'insights', 'document_analyses', 'import_rows', 'page_changes', 'source_snapshots', 'source_runs', 'documents', 'imports', 'sources', 'products', 'memberships']) {
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
