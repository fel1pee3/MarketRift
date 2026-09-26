import assert from 'node:assert/strict';
import test from 'node:test';
import type { Request } from 'express';
import { Accounts, Role } from '../src/accounts';
import { Db } from '../src/db';
import { ReviewableSignalsController, activityFact, pageFact, signalKeyForHistory } from '../src/reviewable-signals';

const id = '11111111-1111-4111-8111-111111111111';
const basePage = { id, source_id: id, product_id: id, source_type: 'pricing_page' as const,
  source_url: 'https://example.com/pricing', previous_snapshot_id: id, current_snapshot_id: id,
  change_details: [], previous_url: 'https://example.com/pricing', current_url: 'https://example.com/pricing',
  previous_hash: 'a'.repeat(64), current_hash: 'b'.repeat(64),
  previous_text: 'Pro USD 10 per month API access', current_text: 'Pro USD 12 per month API access',
  previous_extracted: { plans: [] }, current_extracted: { plans: [] },
  previous_at: new Date('2026-09-01'), current_at: new Date('2026-09-02'), detected_at: new Date('2026-09-02') };
const before = { name: 'Pro', amount: '10', currency: 'USD', period: 'month', conditions: 'API access',
  confirmed: true, evidence: basePage.previous_text };
const after = { ...before, amount: '12', evidence: basePage.current_text };

test('only literal, confirmed, comparable price creates a test-marked candidate', () => {
  const fact = pageFact(basePage, { kind: 'price_observed', previous: before, current: after }, [id]);
  assert.equal(fact?.type, 'price_change');
  assert.equal(fact?.testData, true);
  assert.equal(fact?.evidence.previous && typeof fact.evidence.previous, 'object');
  for (const detail of [
    { kind: 'terms_or_text_changed', previous: before, current: after },
    { kind: 'price_observed', previous: before, current: { ...after, currency: 'EUR' } },
    { kind: 'price_observed', previous: before, current: { ...after, period: 'year' } },
    { kind: 'price_observed', previous: before, current: { ...after, evidence: 'Invented quote' } },
    { kind: 'price_observed', previous: before, current: { ...after, conditions: '' } },
  ]) assert.equal(pageFact(basePage, detail, [id]), null);
});

test('editorial page is not a release; only a new entry with literal evidence qualifies', () => {
  const release = { ...basePage, source_type: 'release_notes' as const,
    previous_text: 'Changelog Version 1', current_text: 'Changelog Version 2 Fixed sync',
    current_url: 'https://example.com/changelog',
    current_extracted: { entries: [{ title: 'Version 2', url: 'https://example.com/releases/2',
      evidence: 'Version 2 Fixed sync' }] } };
  const entry = { title: 'Version 2', url: 'https://example.com/releases/2', evidence: 'Version 2 Fixed sync' };
  assert.equal(pageFact(release, { kind: 'entry_appeared', previous: null, current: entry }, [id])?.type, 'release_entry');
  assert.equal(pageFact(release, { kind: 'entry_appeared', previous: null,
    current: { ...entry, evidence: 'Made-up product launch' } }, [id]), null);
  assert.equal(pageFact(release, { kind: 'entry_changed', previous: entry, current: entry }, [id]), null);
});

test('public activity deduplicates the same source ID across two products and reports partial cursor', () => {
  const sources = [{ id, product_id: id, source_type: 'github_discussions' as const,
    url: 'https://github.com/vercel/next.js', run_id: id, scan_complete: false, finished_at: new Date() },
  { id: '22222222-2222-4222-8222-222222222222', product_id: '33333333-3333-4333-8333-333333333333',
    source_type: 'github_discussions' as const, url: 'https://github.com/vercel/next.js',
    run_id: null, scan_complete: null, finished_at: null }];
  const document = { id, source_id: id, external_key: 'D_1', source_url: 'https://github.com/vercel/next.js/discussions/1',
    source_title: 'Public feedback', source_created_at: new Date('2026-09-01'),
    source_updated_at: new Date('2026-09-02'), collected_at: new Date('2026-09-02'),
    source_repository: 'vercel/next.js', synthetic: false };
  const fact = activityFact(sources, [document, { ...document, id: sources[1]!.id, source_id: sources[1]!.id }]);
  assert.equal(fact?.evidence.count, 1);
  assert.equal(fact?.evidence.coverage, 'partial_cursor');
  assert.equal((fact?.evidence.product_ids as string[]).length, 2);
  assert.equal(activityFact(sources, [{ ...document, synthetic: true }]), null);
});

test('unchanged facts keep approved keys; coverage changes and restored sources create another version', () => {
  const oldKey = 'a'.repeat(64);
  const historical = { id, fact_key: oldKey, state: 'approved',
    evidence: { coverage: 'partial_cursor' }, updated_at: new Date('2026-09-01') };
  assert.equal(signalKeyForHistory(oldKey, 'partial_cursor', [historical]), oldKey);
  const changed = signalKeyForHistory(oldKey, 'complete_for_latest_scan', [historical]);
  assert.notEqual(changed, oldKey);
  assert.notEqual(signalKeyForHistory(oldKey, 'partial_cursor', [{ ...historical, state: 'obsolete' }]), oldKey);
  assert.equal(signalKeyForHistory(oldKey, undefined, []), oldKey);
});

test('viewer and analyst cannot refresh or review; tenant context comes from principal', async () => {
  for (const role of ['analyst', 'viewer'] as Role[]) {
    const accounts = { principal: async (_request: Request, allowed: Role[]) => {
      if (!allowed.includes(role)) throw Object.assign(new Error('Forbidden'), { status: 403 });
      return { tenantId: id, userId: id, role };
    } } as unknown as Accounts;
    const db = { tenant: async () => { throw new Error('Database must not be touched'); } } as unknown as Db;
    const controller = new ReviewableSignalsController(db, accounts);
    await assert.rejects(controller.refresh({} as Request), { status: 403 });
    await assert.rejects(controller.review({} as Request, id, { state: 'approved', reason: 'reviewed' }), { status: 403 });
  }
});
