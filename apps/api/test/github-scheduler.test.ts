import assert from 'node:assert/strict';
import test from 'node:test';
import { Db } from '../src/db';
import { Jobs } from '../src/queue';
import { GitHubScheduler } from '../src/github-scheduler';

const tenant = '11111111-1111-4111-8111-111111111111';
const source = '22222222-2222-4222-8222-222222222222';
const run = '33333333-3333-4333-8333-333333333333';

test('scheduled GitHub job is bounded, versioned and shares the manual active-run guard', async () => {
  const sql: string[] = [];
  const connection = { query: async (statement: string) => {
    sql.push(statement);
    if (statement.includes('pg_try_advisory_xact_lock')) return { rows: [{ locked: true }] };
    if (statement.includes('count(*)::int AS n')) return { rows: [{ n: 0 }] };
    if (statement.includes('SELECT s.id AS source_id')) return { rows: [{ source_id: source,
      tenant_id: tenant, source_type: 'github_discussions', github_monitor_generation: 4 }] };
    if (statement.includes('SELECT cursor_after,scan_complete')) return { rows: [] };
    if (statement.includes('INSERT INTO marketrift.source_runs')) return { rows: [{ id: run,
      tenant_id: tenant, source_id: source, github_monitor_generation: 4 }] };
    return { rows: [] };
  }, release: () => undefined };
  const db = { provisioning: { connect: async () => connection } } as unknown as Db;
  let published: unknown;
  const jobs = { publishDiscussions: async (job: unknown) => { published = job; } } as unknown as Jobs;
  assert.equal(await new GitHubScheduler(db, jobs).tick(), 'scheduled');
  assert.deepEqual(Object.keys(published as object).sort(),
    ['idempotency_key', 'monitor_generation', 'run_id', 'source_id', 'tenant_id', 'version']);
  assert.equal((published as { monitor_generation: number }).monitor_generation, 4);
  assert(sql.some(value => value.includes('r.status IN (\'pending\',\'running\')')));
  assert(sql.some(value => value.includes("other.url=s.url")));
  assert(sql.some(value => value.includes("VALUES ($1,$2,'pending','connector','scheduled'")));
});

test('Redis failure retains the pending run for a later scheduler instance', async () => {
  const connection = { query: async (statement: string) => {
    if (statement.includes('pg_try_advisory_xact_lock')) return { rows: [{ locked: true }] };
    if (statement.includes('SELECT r.id,r.tenant_id,r.source_id')) return { rows: [{ id: run,
      tenant_id: tenant, source_id: source, source_type: 'github_issues',
      github_monitor_generation: 2 }] };
    return { rows: [] };
  }, release: () => undefined };
  const db = { provisioning: { connect: async () => connection } } as unknown as Db;
  let attempts = 0;
  const jobs = { publishGitHub: async () => { if (++attempts === 1) throw new Error('redis'); } } as unknown as Jobs;
  assert.equal(await new GitHubScheduler(db, jobs).tick(), 'publish_failed');
  assert.equal(await new GitHubScheduler(db, jobs).tick(), 'recovered');
  assert.equal(attempts, 2);
});

test('advisory lock prevents another instance claiming the same source', async () => {
  const connection = { query: async (statement: string) => statement.includes('pg_try_advisory_xact_lock')
    ? { rows: [{ locked: false }] } : { rows: [] }, release: () => undefined };
  const db = { provisioning: { connect: async () => connection } } as unknown as Db;
  assert.equal(await new GitHubScheduler(db, {} as Jobs).tick(), 'locked');
});
