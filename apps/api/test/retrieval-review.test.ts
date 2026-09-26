import assert from 'node:assert/strict';
import test from 'node:test';
import type { Request } from 'express';
import { RetrievalReviewController, corpusHash, judgmentCoverage, judgmentHash } from '../src/retrieval-review';
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
