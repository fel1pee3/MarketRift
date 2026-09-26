import assert from 'node:assert/strict';
import test from 'node:test';
import { Db } from '../src/db';
import { Jobs } from '../src/queue';
import { SignalScheduler } from '../src/signal-scheduler';
import { makeSignalJob, parseSignalJob } from '../src/signal-job';

const tenant = '11111111-1111-4111-8111-111111111111';
const source = '22222222-2222-4222-8222-222222222222';

test('signal job carries only tenant, source, revision and stable idempotency key', () => {
  const job = makeSignalJob(tenant, source, '3');
  assert.deepEqual(Object.keys(job).sort(), ['idempotency_key', 'revision', 'source_id', 'tenant_id', 'version']);
  assert.equal(parseSignalJob(job).idempotency_key, `signal-reconcile-${source}-3-v1`);
  assert.throws(() => parseSignalJob({ ...job, idempotency_key: 'wrong' }));
  assert.throws(() => parseSignalJob({ ...job, review_text: 'must never enter Redis' }));
});

test('failed publication leaves durable work due and next tick republishes it', async () => {
  const calls: string[] = [];
  const connection = { query: async (sql: string) => {
    calls.push(sql);
    return sql.includes('signal_reconcile_sources') ?
      { rows: [{ tenant_id: tenant, source_id: source, requested_revision: '3' }] } : { rows: [] };
  }, release: () => undefined };
  const db = { provisioning: { connect: async () => connection } } as unknown as Db;
  let publishes = 0;
  const jobs = { publishSignal: async () => { publishes++;
    if (publishes === 1) throw new Error('redis unavailable'); } } as unknown as Jobs;
  const scheduler = new SignalScheduler(db, jobs);
  assert.equal(await scheduler.tick(), 'publish_failed');
  assert.equal(await new SignalScheduler(db, jobs).tick(), 'published');
  assert.equal(publishes, 2);
  assert.equal(calls.some(sql => sql.includes('UPDATE marketrift.signal_reconcile_sources')), false);
});
