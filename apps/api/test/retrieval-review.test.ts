import assert from 'node:assert/strict';
import test from 'node:test';
import type { Request } from 'express';
import { RetrievalReviewController, corpusHash, frozenContractVersion, frozenEvaluatorVersion,
  judgmentCoverage, judgmentHash, reportMatchesDataset, reportMismatchField } from '../src/retrieval-review';
import { Db } from '../src/db';
import { Accounts, type Role } from '../src/accounts';

const tenant = 'b522d3cb-556c-46f3-bca3-a4d9a3a75e69';
const set = 'e8f28408-d57b-4839-989b-f519550c8e0d';
const product = '79d47c62-9f2e-4dd6-97db-abdbbbfd7660';

test('frozen corpus and judgments have stable, distinct fingerprints', () => {
  const items = [{ id: 'a', chunk_id: 'c', text_hash: 'h1', content_version: 'v1' }] as Parameters<typeof corpusHash>[0];
  const questions = [{ id: 'q', text_content: 'What changed?', language: 'en', no_answer_claim: false }] as Parameters<typeof judgmentHash>[0];
  const judgments = [{ question_id: 'q', item_id: 'a', verdict: 'relevant', reviewer_id: 'u', revision: 1 }] as Parameters<typeof judgmentHash>[1];
  assert.notEqual(corpusHash(items), corpusHash([{ ...items[0]!, text_hash: 'h2' }]));
  assert.notEqual(judgmentHash(questions, judgments), judgmentHash(questions,
    [{ ...judgments[0]!, verdict: 'irrelevant' }]));
  assert.deepEqual(judgmentCoverage(items, questions, judgments), {
    judged: 1, total: 1, complete_questions: 1, unjudged: 0, fully_judged: true,
  });
});

test('viewer cannot label; tenant from browser cannot override active membership', async () => {
  for (const role of ['viewer', 'analyst'] as Role[]) {
    const visited: string[] = [];
    const accounts = { principal: async (_request: Request, allowed: Role[] = ['owner', 'admin', 'analyst', 'viewer']) => {
      if (!allowed.includes(role)) throw Object.assign(new Error('Forbidden'), { status: 403 });
      return { tenantId: tenant, userId: '20bbdf0f-7906-480d-b616-e689ccad48d5', role };
    } } as unknown as Accounts;
    const db = { tenant: async (tenantId: string, work: (client: object) => Promise<unknown>) => {
      visited.push(tenantId); return work({});
    }, rows: async () => [] } as unknown as Db;
    const controller = new RetrievalReviewController(db, accounts);
    const request = {} as Request;
    const body = { item_id: product, verdict: 'relevant', tenant_id: 'foreign' };
    await assert.rejects(controller.judge(request, set, product, body), { status: role === 'viewer' ? 403 : 400 });
    assert.deepEqual(visited, []);
    if (role === 'analyst') {
      await assert.rejects(controller.detail(request, set), { status: 400 });
      assert.deepEqual(visited, [tenant]);
    }
  }
});

test('report identity and candidate IDs must match the frozen v2 dataset', () => {
  const ids = Array.from({ length: 5 }, (_, index) => `00000000-0000-4000-8000-00000000000${index}`);
  const questionId = '11111111-1111-4111-8111-111111111111';
  const dataset = { set_id: set, version: 'public-github.v2', origin: 'real' as const, index_version: 'index-v1',
    corpus_hash: 'a'.repeat(64), judgment_hash: 'b'.repeat(64),
    documents: ids.map(id => ({ id })), questions: [{ id: questionId, judged_ids: [...ids], relevant_ids: [ids[2]!] }] };
  const run = { ranked_ids: { [questionId]: ids },
    ranking_coverage: { [questionId]: { eligible_count: 5, ranked_count: 5, excluded: [] } } };
  const result = { contract_version: frozenContractVersion, evaluator_version: frozenEvaluatorVersion,
    set_id: dataset.set_id, dataset_version: dataset.version,
    origin: 'public_github_real', index_version: dataset.index_version,
    corpus_hash: dataset.corpus_hash, judgment_hash: dataset.judgment_hash,
    corpus_size: 5, question_count: 1, document_ids: [...ids], question_ids: [questionId],
    labels_by_question: { [questionId]: { judged_ids: [...ids], relevant_ids: [ids[2]!] } },
    runs: { local: run, controlled: run, literal: run } };
  assert.equal(reportMatchesDataset(result, dataset), true);
  assert.equal(reportMismatchField({ ...result, contract_version: undefined }, dataset), 'contract_version');
  assert.equal(reportMismatchField({ ...result, evaluator_version: undefined }, dataset), 'evaluator_version');
  assert.equal(reportMismatchField({ ...result, set_id: 'another-set' }, dataset), 'set_id');
  assert.equal(reportMismatchField({ ...result, dataset_version: 'public-github.v1' }, dataset), 'dataset_version');
  assert.equal(reportMismatchField({ ...result, corpus_hash: 'c'.repeat(64) }, dataset), 'corpus_hash');
  assert.equal(reportMismatchField({ ...result, judgment_hash: 'c'.repeat(64) }, dataset), 'judgment_hash');
  assert.equal(reportMismatchField({ ...result, document_ids: [...ids].reverse() }, dataset), 'document_ids');
  assert.equal(reportMismatchField({ ...result, question_ids: ['other'] }, dataset), 'question_ids');
  assert.equal(reportMismatchField({ ...result, labels_by_question: { [questionId]: {
    judged_ids: [...ids].reverse(), relevant_ids: [ids[2]!] } } }, dataset),
  `labels_by_question.${questionId}.judged_ids`);
  assert.equal(reportMismatchField({ ...result, labels_by_question: { [questionId]: {
    judged_ids: [...ids], relevant_ids: [ids[3]!] } } }, dataset),
  `labels_by_question.${questionId}.relevant_ids`);
  assert.equal(reportMismatchField({ ...result, runs: { ...result.runs,
    local: { ...run, ranked_ids: { [questionId]: [...ids.slice(0, 4), 'foreign'] } } } }, dataset),
  `runs.local.ranked_ids.${questionId}`);
  assert.equal(reportMismatchField({ ...result, runs: { ...result.runs,
    local: { ...run, ranking_coverage: { [questionId]: { eligible_count: 5, ranked_count: 4,
      excluded: [] } } } } }, dataset), `runs.local.ranking_coverage.${questionId}`);
  assert.equal(reportMatchesDataset({ ...result, document_ids: [...ids].reverse() }, dataset), false);
});

test('older report is obsolete and detail queries only the selected set', async () => {
  const item = { id: product, chunk_id: 'chunk', text_hash: 'a'.repeat(64), content_version: 'v1',
    source_type: 'github_discussion', text_content: 'public test', source_id: 'source' };
  const question = { id: product, text_content: 'What happened?', language: 'en', no_answer_claim: false };
  const judgment = { question_id: product, item_id: product, verdict: 'relevant',
    reviewer_id: 'user', revision: 1 };
  const setRow = { id: set, version: 2, status: 'frozen', origin: 'public_real' };
  const oldReport = { id: 'old-report', set_id: set, corpus_hash: corpusHash([item] as Parameters<typeof corpusHash>[0]),
    judgment_hash: judgmentHash([question] as Parameters<typeof judgmentHash>[0],
      [judgment] as Parameters<typeof judgmentHash>[1]),
    result: { dataset_version: 'public-github.v2' } };
  const reportQueries: unknown[][] = [];
  const db = { tenant: async (_tenantId: string, work: (client: object) => Promise<unknown>) => work({}),
    rows: async (_client: object, sql: string, args: unknown[]) => {
      if (sql.includes('FROM marketrift.retrieval_sets')) return [setRow];
      if (sql.includes('LEFT JOIN marketrift.documents')) return []; // no stale source
      if (sql.includes('FROM marketrift.retrieval_items')) return [item];
      if (sql.includes('FROM marketrift.retrieval_questions')) return [question];
      if (sql.includes('FROM marketrift.retrieval_judgments')) return [judgment];
      if (sql.includes('FROM marketrift.retrieval_reports')) { reportQueries.push(args); return [oldReport]; }
      return []; // staleItems
    } } as unknown as Db;
  const accounts = { principal: async () => ({ tenantId: tenant, userId: 'user', role: 'viewer' }) } as unknown as Accounts;
  const result = await new RetrievalReviewController(db, accounts).detail({} as Request, set);
  assert.deepEqual(reportQueries, [[set]]);
  assert.equal(result.set.version, 2);
  assert.equal(result.reports[0]?.obsolete, true);
  assert.equal(result.reports[0]?.stale, false);
});

test('outdated FastAPI contract fails before ranking with an actionable field', async () => {
  const item = { id: product, chunk_id: 'chunk', text_hash: 'a'.repeat(64), content_version: 'v1',
    source_type: 'github_discussion', text_content: 'Synthetic public test', source_id: 'source' };
  const setRow = { id: set, version: 2, status: 'frozen', origin: 'synthetic_test',
    corpus_hash: corpusHash([item] as Parameters<typeof corpusHash>[0]) };
  const question = { id: product, text_content: 'What happened?', language: 'en', no_answer_claim: false };
  const judgment = { question_id: product, item_id: product, verdict: 'relevant',
    reviewer_id: 'user', revision: 1 };
  const db = { tenant: async (_tenantId: string, work: (client: object) => Promise<unknown>) => work({}),
    rows: async (_client: object, sql: string) => {
      if (sql.includes('FROM marketrift.retrieval_sets')) return [setRow];
      if (sql.includes('LEFT JOIN marketrift.documents')) return [];
      if (sql.includes('FROM marketrift.retrieval_items')) return [item];
      if (sql.includes('FROM marketrift.retrieval_questions')) return [question];
      if (sql.includes('FROM marketrift.retrieval_judgments')) return [judgment];
      throw new Error('Unexpected query');
    } } as unknown as Db;
  const accounts = { principal: async () => ({ tenantId: tenant, userId: 'user', role: 'owner' }) } as unknown as Accounts;
  const original = { provider: process.env.EMBEDDING_PROVIDER, test: process.env.RETRIEVAL_REVIEW_TEST_MODE,
    token: process.env.EMBEDDING_INTERNAL_TOKEN, url: process.env.EMBEDDING_INTERNAL_URL, fetch: global.fetch };
  process.env.EMBEDDING_PROVIDER = 'controlled';
  process.env.RETRIEVAL_REVIEW_TEST_MODE = '1';
  process.env.EMBEDDING_INTERNAL_TOKEN = 'test-only-token';
  process.env.EMBEDDING_INTERNAL_URL = 'http://127.0.0.1:3212';
  let calls = 0;
  global.fetch = async () => { calls += 1; return Response.json({ model: 'controlled-hash-TESTE', version: '1',
    retrieval_evaluator_version: frozenEvaluatorVersion }); };
  try {
    await assert.rejects(new RetrievalReviewController(db, accounts).evaluate({} as Request, set),
      (error: unknown) => typeof error === 'object' && error !== null && 'status' in error &&
        error.status === 409 && 'message' in error && String(error.message).includes('retrieval_contract_version'));
    assert.equal(calls, 1); // no evaluation request and no report insertion
  } finally {
    global.fetch = original.fetch;
    for (const [key, value] of Object.entries({ EMBEDDING_PROVIDER: original.provider,
      RETRIEVAL_REVIEW_TEST_MODE: original.test, EMBEDDING_INTERNAL_TOKEN: original.token,
      EMBEDDING_INTERNAL_URL: original.url })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
