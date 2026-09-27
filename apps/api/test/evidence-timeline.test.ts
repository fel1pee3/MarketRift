import assert from 'node:assert/strict';
import test from 'node:test';
import { linkFor, timelineFilters } from '../src/evidence-timeline';
import { originDateLabel } from '../../web/src/app/EvidenceTimeline';

const id = '11111111-1111-4111-8111-111111111111';

test('timeline validates tenant-scoped filters, multiple types and bounded pagination', () => {
  assert.deepEqual(timelineFilters({ source_types: 'github_issue,release_notes', limit: '3', offset: '4' }), {
    productId: null, sourceTypes: ['github_issue', 'release_notes'], from: null, to: null,
    limit: 3, offset: 4,
  });
  for (const invalid of [
    { source_types: 'github_issue,github_issue' }, { source_types: 'pricing_page,unknown' },
    { from: '2026-09-28', to: '2026-09-27' }, { limit: '51' }, { offset: '-1' },
    { product_id: 'foreign' }, { tenant_id: id },
  ]) assert.throws(() => timelineFilters(invalid));
});

test('a literal changelog date without a year stays literal', () => {
  assert.equal(originDateLabel(null, '25 September'), '“25 September” (ano não informado)');
  assert.equal(originDateLabel(null, null), 'não informada');
});

test('obsolete signal can link to the same price change or preserved changelog entry', () => {
  const base = { id, source_id: id, page_change_id: id,
    previous_snapshot_id: id, current_snapshot_id: id, signal_type: 'price_change',
    state: 'obsolete', evidence: { withdrawn: true }, change_details: [],
    hypothesis_id: id, hypothesis_status: 'needs_review' };
  const price = { kind: 'price_change' as const, source_type: 'pricing_page',
    source_url: 'https://example.com/pricing', source_ids: [id], relation_ids: [id] };
  assert.equal(linkFor(price, base), 'same_change');
  assert.equal(linkFor({ ...price, source_ids: [] }, base), null);
  const entry = { kind: 'changelog_entry' as const, source_type: 'release_notes',
    source_url: 'https://example.com/changelog/entry', source_ids: [id], relation_ids: [id] };
  assert.equal(linkFor(entry, { ...base, signal_type: 'release_entry',
    change_details: [{ kind: 'entry_appeared', current: { url: entry.source_url } }] }), 'same_entry');
  assert.equal(linkFor({ ...entry, source_url: 'https://example.com/changelog/other' },
    { ...base, signal_type: 'release_entry', change_details: [] }), null);
});
