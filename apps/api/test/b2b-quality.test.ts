import assert from 'node:assert/strict';
import test from 'node:test';
import { conservativeCost, eligibility, externalRights, internalEvaluate, labelProblems } from '../src/b2b-quality';

const body = 'Exemplo sintético: a exportação de faturas falhou duas vezes.';
const base = { body, external_key: 'one', source_url: 'https://example.invalid/b2b/one',
  published_at: new Date('2026-09-01T00:00:00Z'), review_language: null,
  synthetic: true, review_data_status: 'synthetic_fixture', enabled: true, storage_permitted: true,
  access_environment: 'sandbox', rights_reference: 'synthetic fixture', rights_expires_at: null,
  content_hash: '', metadata_hash: '' };

test('literal offsets and decision consistency reject nonexistent evidence', () => {
  const start = body.indexOf('faturas falhou duas vezes');
  assert(start >= 0);
  assert.doesNotThrow(() => labelProblems(body, 'problem', [
    { category: 'features', severity: 'medium', start, end: start + 26 },
  ]));
  assert.throws(() => labelProblems(body, 'problem', [
    { category: 'features', severity: 'medium', start: 999, end: 1005 },
  ]));
  assert.throws(() => labelProblems(body, 'no_problem', [
    { category: 'features', severity: 'medium', start, end: start + 26 },
  ]));
  assert.throws(() => labelProblems(body, 'problem', []));
});

test('revocation, expiry, source type and deletion make stored offsets ineligible', () => {
  assert.equal(eligibility({ ...base, body: null } as never, 'synthetic_test'), 'review_removed_or_storage_revoked');
  assert.equal(eligibility({ ...base, storage_permitted: false } as never, 'synthetic_test'),
    'review_removed_or_storage_revoked');
  assert.equal(eligibility({ ...base, access_environment: 'production' } as never, 'synthetic_test'), 'origin_changed');
  assert.equal(eligibility({ ...base, synthetic: false, review_data_status: 'declared_real',
    access_environment: 'production', rights_expires_at: new Date('2020-01-01') } as never, 'real'), 'storage_rights_expired');
});

test('paid preflight is conservative and includes every selected review plus output tokens', () => {
  const one = conservativeCost([body], 256, 1, 4);
  assert(one > 0);
  assert(conservativeCost([body, body], 256, 1, 4) > one);
  assert(conservativeCost([body], 512, 1, 4) > one);
});

test('external AI rights stay separate from storage and expire or revoke independently', () => {
  const real = { ...base, access_environment: 'production', synthetic: false,
    review_data_status: 'declared_real', rights_expires_at: new Date('2030-01-01'),
    external_ai_permitted: true, ai_provider: 'openai', ai_rights_reference: 'Permission for provider',
    ai_rights_expires_at: new Date('2030-01-01'), ai_rights_revoked_at: null };
  assert.equal(externalRights(real as never, new Date('2026-09-27')), true);
  assert.equal(externalRights({ ...real, external_ai_permitted: false } as never, new Date('2026-09-27')), false);
  assert.equal(externalRights({ ...real, ai_rights_revoked_at: new Date('2026-09-26') } as never,
    new Date('2026-09-27')), false);
  assert.equal(externalRights(real as never, new Date('2031-01-01')), false);
});

test('internal evaluator distinguishes a stopped service from auth and outdated endpoint', async () => {
  const previousFetch = globalThis.fetch;
  const previousUrl = process.env.EMBEDDING_INTERNAL_URL;
  const previousToken = process.env.EMBEDDING_INTERNAL_TOKEN;
  process.env.EMBEDDING_INTERNAL_URL = 'http://127.0.0.1:8000';
  process.env.EMBEDDING_INTERNAL_TOKEN = 'test-internal-token';
  try {
    globalThis.fetch = async () => { throw new TypeError('fetch failed'); };
    await assert.rejects(internalEvaluate({}, {}), /FastAPI não está acessível/);
    globalThis.fetch = async () => new Response('', { status: 401 });
    await assert.rejects(internalEvaluate({}, {}), /Token interno/);
    globalThis.fetch = async () => new Response('', { status: 404 });
    await assert.rejects(internalEvaluate({}, {}), /rota de avaliação/);
    globalThis.fetch = async () => new Response('', { status: 400 });
    await assert.rejects(internalEvaluate({}, {}), /recusou o contrato/);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousUrl === undefined) delete process.env.EMBEDDING_INTERNAL_URL;
    else process.env.EMBEDDING_INTERNAL_URL = previousUrl;
    if (previousToken === undefined) delete process.env.EMBEDDING_INTERNAL_TOKEN;
    else process.env.EMBEDDING_INTERNAL_TOKEN = previousToken;
  }
});
