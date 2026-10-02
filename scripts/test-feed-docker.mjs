// Controlled Linux worker smoke: isolated Redis DB and synthetic tenant; no third-party HTTP.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Queue } from 'bullmq';
import pg from 'pg';

if (!process.env.DATABASE_ADMIN_URL || !process.env.RUNTIME_DATABASE_URL || !process.env.REDIS_URL)
  throw new Error('Database and Redis URLs are required');
const tenant = randomUUID();
const product = randomUUID();
const source = randomUUID();
const run = randomUUID();
const container = `marketrift-feed-smoke-${tenant.slice(0,8)}`;
const envPath = resolve('.tmp', `${container}.env`);
const admin = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL });
const hostRedis = new URL(process.env.REDIS_URL);
hostRedis.pathname = '/14';
const containerRedis = new URL(hostRedis);
containerRedis.hostname = 'redis';
containerRedis.port = '6379';
const containerDatabase = new URL(process.env.RUNTIME_DATABASE_URL);
containerDatabase.hostname = 'postgres';
containerDatabase.port = '5432';
const queue = new Queue('feed-sync', { connection: { host:hostRedis.hostname,
  port:Number(hostRedis.port || 6379), username:decodeURIComponent(hostRedis.username || 'default'),
  password:hostRedis.password ? decodeURIComponent(hostRedis.password) : undefined, db:14,
  maxRetriesPerRequest:1 } });
let child;
let connected = false;
try {
  const counts = await queue.getJobCounts('waiting','active','delayed');
  assert.equal(counts.waiting+counts.active+counts.delayed,0,
    'Redis DB 14 is not empty; leave it untouched');
  await admin.connect();
  connected = true;
  await admin.query('BEGIN');
  await admin.query("INSERT INTO marketrift.tenants(id,name) VALUES ($1,'feed-container-smoke')",[tenant]);
  await admin.query("INSERT INTO marketrift.products(id,tenant_id,name,kind) VALUES ($1,$2,'Synthetic feed','competitor')",
    [product,tenant]);
  await admin.query(`INSERT INTO marketrift.sources
    (id,tenant_id,product_id,source_type,url,monitoring_enabled,check_interval_minutes,next_check_at)
    VALUES ($1,$2,$3,'rss_feed','https://example.com/feed.xml',true,1440,now()+interval '1 day')`,
  [source,tenant,product]);
  await admin.query(`INSERT INTO marketrift.source_runs
    (id,tenant_id,source_id,status,run_kind,trigger_kind,feed_monitor_generation)
    VALUES ($1,$2,$3,'pending','feed','manual',1)`, [run,tenant,source]);
  await admin.query('COMMIT');
  await mkdir(resolve('.tmp'), { recursive:true });
  const env = { RUNTIME_DATABASE_URL:containerDatabase.toString(), REDIS_URL:containerRedis.toString(),
    MARKETRIFT_TEST_MODE:'1', FEED_TEST_BASE_URL:'http://127.0.0.1:34333',
    EMBEDDING_PROVIDER:'controlled', ANALYSIS_PROVIDER:'test' };
  await writeFile(envPath,Object.entries(env).map(([key,value])=>`${key}=${value}`).join('\n')+'\n',
    { mode:0o600 });
  const fixture = `from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread
import asyncio
from marketrift_intelligence.worker import main
class Handler(BaseHTTPRequestHandler):
 def log_message(self,*args): pass
 def do_GET(self):
  if self.path == '/feed/robots.txt':
   body=b'User-agent: *\\nAllow: /\\n'; kind='text/plain'
  else:
   detail=b''.join(('<tag%d>value</tag%d>' % (i,i)).encode() for i in range(25))
   items=b''.join(b'<entry><id>smoke-'+str(i).encode()+b'</id><title>Synthetic update</title><link href="https://example.com/post/'+str(i).encode()+b'"/><updated>2026-10-01T12:00:00Z</updated>'+detail+b'</entry>' for i in range(163))
   body=b'<feed xmlns="http://www.w3.org/2005/Atom">'+items+b'<!--'+b'x'*520000+b'--></feed>'; kind='application/atom+xml'
  self.send_response(200); self.send_header('Content-Type',kind); self.send_header('Content-Length',str(len(body))); self.end_headers(); self.wfile.write(body)
Thread(target=ThreadingHTTPServer(('127.0.0.1',34333),Handler).serve_forever,daemon=True).start()
asyncio.run(main())`;
  child = spawn('docker',['run','--rm','--name',container,'--network','marketrift_default',
    '--env-file',envPath,'--entrypoint','python','marketrift-worker','-c',fixture],
  { stdio:['ignore','ignore','pipe'] });
  child.stderr.on('data', () => undefined);
  child.on('error', () => undefined);
  await delay(1500);
  await queue.add('sync-feed.v1', { version:1,tenant_id:tenant,source_id:source,run_id:run,
    monitor_generation:1,idempotency_key:`feed-${run}-v1` },
  { jobId:`feed-${run}-v1`,attempts:1,removeOnComplete:true,removeOnFail:true });
  let result;
  for (let attempt=0;attempt<80;attempt++) {
    result=(await admin.query('SELECT status,error_code,documents_new,scan_complete FROM marketrift.source_runs WHERE id=$1',[run])).rows[0];
    if (result.status==='succeeded' || result.status==='failed' || result.status==='cancelled') break;
    await delay(250);
  }
  assert.equal(result?.status,'succeeded',`Linux feed worker did not complete: ${result?.error_code || 'worker_unavailable'}`);
  assert.equal(result.documents_new,20);
  assert.equal(result.scan_complete,false,'A bounded prefix must never claim complete feed coverage');
  const entries=(await admin.query('SELECT count(*)::int AS n FROM marketrift.feed_entries WHERE source_id=$1',[source])).rows[0].n;
  assert.equal(entries,20);
  console.log(JSON.stringify({ status:'passed', transport:'Linux container + local oversized Atom fixture', entries, scan_complete:result.scan_complete }));
} finally {
  if (child) {
    const stop = spawnSync('docker',['stop','--time','1',container], { stdio:'ignore' });
    if (stop.status !== 0) child.kill();
  }
  await queue.close();
  if (connected) {
    await admin.query('ROLLBACK').catch(()=>undefined);
    for (const table of ['feed_entry_versions','feed_entries','source_runs','sources','products'])
      await admin.query(`DELETE FROM marketrift.${table} WHERE tenant_id=$1`,[tenant]);
    await admin.query('DELETE FROM marketrift.tenants WHERE id=$1',[tenant]);
    await admin.end();
  }
  await rm(envPath,{force:true});
}
