import assert from 'node:assert/strict';
import test from 'node:test';
import { Db } from '../src/db';
import { Jobs } from '../src/queue';
import { FeedScheduler } from '../src/feed-scheduler';
import { makeFeedJob } from '../src/feed-job';
import { FeedsController } from '../src/feeds';
import { Accounts } from '../src/accounts';

const tenant = '11111111-1111-4111-8111-111111111111';
const source = '22222222-2222-4222-8222-222222222222';
const run = '33333333-3333-4333-8333-333333333333';

test('feed job contains only IDs, version and idempotence key', () => {
  assert.deepEqual(makeFeedJob(tenant,source,run,2), {
    version:1,tenant_id:tenant,source_id:source,run_id:run,
    idempotency_key:`feed-${run}-v1`,monitor_generation:2,
  });
});

test('one scheduler claims a bounded feed run and uses source revision', async () => {
  const sql: string[] = [];
  const client = { query: async (statement: string) => {
    sql.push(statement);
    if (statement.includes('pg_try_advisory_xact_lock')) return { rows:[{ locked:true }] };
    if (statement.includes('SELECT s.id,s.tenant_id,s.feed_monitor_generation'))
      return { rows:[{ id:source,tenant_id:tenant,feed_monitor_generation:5 }] };
    if (statement.includes('INSERT INTO marketrift.source_runs'))
      return { rows:[{ id:run,source_id:source,tenant_id:tenant,trigger_kind:'scheduled',
        feed_monitor_generation:5 }] };
    return { rows:[] };
  }, release:()=>undefined };
  const db = { provisioning:{ connect:async () => client } } as unknown as Db;
  let published: unknown;
  const jobs = { publishFeed:async (job:unknown) => { published=job; } } as unknown as Jobs;
  assert.equal(await new FeedScheduler(db,jobs).tick(),'scheduled');
  assert.equal((published as { monitor_generation:number }).monitor_generation,5);
  assert(sql.some(value => value.includes('pg_try_advisory_xact_lock')));
  assert(sql.some(value => value.includes("r.status IN ('pending','running')")));
  assert(sql.some(value => value.includes("other.source_type='rss_feed'")));
});

test('pending run survives Redis failure; second scheduler recovers it', async () => {
  const client = { query:async (statement:string) => {
    if (statement.includes('pg_try_advisory_xact_lock')) return { rows:[{ locked:true }] };
    if (statement.includes('SELECT r.id,r.tenant_id,r.source_id'))
      return { rows:[{ id:run,source_id:source,tenant_id:tenant,trigger_kind:'manual',
        feed_monitor_generation:null }] };
    return { rows:[] };
  }, release:()=>undefined };
  const db = { provisioning:{ connect:async () => client } } as unknown as Db;
  let calls = 0;
  const jobs = { publishFeed:async () => { if (++calls===1) throw new Error('redis'); } } as unknown as Jobs;
  assert.equal(await new FeedScheduler(db,jobs).tick(),'publish_failed');
  assert.equal(await new FeedScheduler(db,jobs).tick(),'recovered');
  assert.equal(calls,2);
});

test('advisory lock prevents two instances claiming the same run', async () => {
  const client = { query:async (statement:string) => statement.includes('pg_try_advisory_xact_lock')
    ? { rows:[{ locked:false }] } : { rows:[] }, release:()=>undefined };
  const db = { provisioning:{ connect:async () => client } } as unknown as Db;
  assert.equal(await new FeedScheduler(db,{} as Jobs).tick(),'locked');
});

test('repeated manual click returns the same pending run without another BullMQ publish', async () => {
  const pending = { id:run,source_id:source,status:'pending',feed_monitor_generation:3 };
  const client = { query:async () => ({ rows:[] }) };
  const db = { tenant:async (_tenant:string, callback:(value:unknown)=>Promise<unknown>) =>
    callback(client), rows:async (_client:unknown, sql:string) => {
      if (sql.includes('SELECT s.*')) return [{ id:source,enabled:true,monitoring_enabled:true,
        feed_monitor_generation:3 }];
      if (sql.includes('SELECT * FROM marketrift.source_runs')) return [pending];
      throw new Error(`Unexpected SQL in pending-click test: ${sql}`);
    } } as unknown as Db;
  let published = 0;
  const jobs = { publishFeed:async () => { published += 1; } } as unknown as Jobs;
  const accounts = { principal:async () => ({ tenantId:tenant,userId:tenant }) } as unknown as Accounts;
  const controller = new FeedsController(db,jobs,accounts);
  assert.equal((await controller.run({} as never,source)).id,run);
  assert.equal((await controller.run({} as never,source)).id,run);
  assert.equal(published,0);
});
