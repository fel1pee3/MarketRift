/** Isolated synthetic restore drill. Never reads DATABASE_ADMIN_URL or the existing compose volume. */
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync,
  writeFileSync, writeSync, closeSync } from 'node:fs';
import { createServer } from 'node:net';
import { resolve, join } from 'node:path';
import pg from 'pg';
import { backup, restore, startLabContainer, startLabRedis, stopLabContainer, verify } from './ops.mjs';
import { auditDestination, releaseDestination } from './quarantine.mjs';

const { Client } = pg;
const suffix = randomBytes(4).toString('hex');
const sourceContainer = `marketrift-backup-lab-source-${suffix}`;
const restoreContainer = `marketrift-backup-lab-restore-${suffix}`;
const redisContainer = `marketrift-backup-lab-redis-${suffix}`;
const database = `marketrift_backup_lab_${suffix}`;
const root = resolve('.tmp', 'backup-lab', suffix);
const journalDir = join(root, 'deletions');
const archive = join(root, 'synthetic.dump');
const key = randomBytes(32).toString('hex');
const sourcePassword = randomBytes(24).toString('hex');
const restorePassword = randomBytes(24).toString('hex');
const runtimePassword = randomBytes(24).toString('hex');
const provisionPassword = randomBytes(24).toString('hex');
const report = { status: 'starting', backup: 'not_started', verification: 'not_started',
  restore: 'not_started', quarantine: 'not_checked', journal_events: 0,
  backup_failure_reported: false, corrupted_backup_rejected: false,
  restore_initially_blocked: false, missing_event_release_rejected: false,
  unavailable_journal_rejected: false, invalid_signature_rejected: false,
  real_release_blocked: false,
  audit_trail: false,
  api_blocked: false, worker_blocked: false, scheduler_blocked: false,
  intelligence_http_blocked: false,
  processes_released: false, old_jobs_rejected: false, rls: false };
mkdirSync(journalDir, { recursive: true });
writeFileSync(join(root, 'journal.key'), key, { flag: 'wx', mode: 0o600 });
process.env.BACKUP_DELETION_JOURNAL_DIR = journalDir;
process.env.BACKUP_DELETION_JOURNAL_KEY = key;
const { recordDeletion, readDeletionJournal, externalKeyHmac } =
  await import('../../apps/api/dist/deletion-journal.js');
const { Db } = await import('../../apps/api/dist/db.js');
const { B2BRightsLifecycle } = await import('../../apps/api/dist/b2b-rights-lifecycle.js');
const ids = { tenantA: randomUUID(), tenantB: randomUUID(), user: randomUUID(),
  productA: randomUUID(), productB: randomUUID(), sourceDeleted: randomUUID(),
  sourceALive: randomUUID(), sourceExpired: randomUUID(), sourceRevoked: randomUUID(),
  sourceBLive: randomUUID(),
  documentDeleted: randomUUID(), documentALive: randomUUID(), documentExpired: randomUUID(),
  documentBLive: randomUUID(), documentRevoked: randomUUID(),
  importDeleted: randomUUID(), importExpired: randomUUID(), importRevoked: randomUUID(),
  set: randomUUID(), item: randomUUID() };
const removedKey = 'synthetic-deleted-001';

function url(password, port) {
  return `postgres://postgres:${password}@127.0.0.1:${port}/${database}`;
}
async function connected(connectionString) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const client = new Client({ connectionString });
    try { await client.connect(); client.on('error', () => {}); return client; }
    catch { await client.end().catch(() => {}); await new Promise(r => setTimeout(r, 200)); }
  }
  throw new Error('isolated_postgres_unavailable');
}
async function seed(client) {
  await client.query('BEGIN');
  try {
    await client.query(`INSERT INTO marketrift.tenants(id,name) VALUES($1,'Synthetic A'),($2,'Synthetic B')`,
      [ids.tenantA, ids.tenantB]);
    await client.query(`INSERT INTO marketrift.users(id,email,display_name,password_hash)
      VALUES($1,'restore-lab@example.invalid','Synthetic reviewer','synthetic-not-a-real-hash')`, [ids.user]);
    for (const tenant of [ids.tenantA, ids.tenantB])
      await client.query(`INSERT INTO marketrift.memberships(tenant_id,user_id,role)
        VALUES($1,$2,'owner')`, [tenant, ids.user]);
    for (const [tenant, product] of [[ids.tenantA, ids.productA], [ids.tenantB, ids.productB]])
      await client.query(`INSERT INTO marketrift.products(id,tenant_id,name,kind)
        VALUES($1,$2,'Synthetic product','own')`, [product, tenant]);
    const sourceRows = [
      [ids.sourceDeleted, ids.tenantA, ids.productA, 'sandbox', '2099-01-01', 'retain_after_expiry'],
      [ids.sourceALive, ids.tenantA, ids.productA, 'sandbox', '2099-01-01', 'retain_after_expiry'],
      [ids.sourceExpired, ids.tenantB, ids.productB, 'production', '2020-01-01', 'delete_on_expiry'],
      [ids.sourceRevoked, ids.tenantA, ids.productA, 'production', '2099-01-01', 'retain_after_expiry'],
      [ids.sourceBLive, ids.tenantB, ids.productB, 'sandbox', '2099-01-01', 'retain_after_expiry'],
    ];
    for (const [source, tenant, product, environment, expiry, policy] of sourceRows)
      await client.query(`INSERT INTO marketrift.sources(id,tenant_id,product_id,source_type,url,
        access_environment,access_status,rights_reference,storage_permitted,rights_expires_at,
        b2b_retention_policy) VALUES($1,$2,$3,'b2b_csv_review',$4,$5,'authorized',
        'SYNTHETIC LAB ONLY',true,$6,$7)`,
      [source,tenant,product,`https://example.invalid/${source}`,environment,expiry,policy]);
    const documents = [
      [ids.documentDeleted, ids.tenantA, ids.sourceDeleted, removedKey],
      [ids.documentALive, ids.tenantA, ids.sourceALive, 'synthetic-live-a'],
      [ids.documentExpired, ids.tenantB, ids.sourceExpired, 'synthetic-expired'],
      [ids.documentRevoked, ids.tenantA, ids.sourceRevoked, 'synthetic-revoked'],
      [ids.documentBLive, ids.tenantB, ids.sourceBLive, 'synthetic-live-b'],
    ];
    for (const [document, tenant, source, external] of documents)
      await client.query(`INSERT INTO marketrift.documents(id,tenant_id,source_id,document_type,
        external_key,source_url,body,synthetic,review_data_status)
        VALUES($1,$2,$3,'b2b_review',$4,'https://example.invalid/synthetic',
        'Synthetic restoration exercise only',true,'synthetic_fixture')`,
      [document,tenant,source,external]);
    for (const [id,tenant,source,external] of [
      [ids.importDeleted,ids.tenantA,ids.sourceDeleted,removedKey],
      [ids.importExpired,ids.tenantB,ids.sourceExpired,'synthetic-expired'],
      [ids.importRevoked,ids.tenantA,ids.sourceRevoked,'synthetic-revoked']]) {
      await client.query(`INSERT INTO marketrift.imports(id,tenant_id,source_id,idempotency_key,
        status,b2b_rights_generation) VALUES($1,$2,$3,$4,'queued',1)`,
      [id,tenant,source,`synthetic-${id}`]);
      await client.query(`INSERT INTO marketrift.import_rows(tenant_id,import_id,external_key,
        source_url,body,synthetic) VALUES($1,$2,$3,'https://example.invalid/synthetic',
        'Synthetic raw text for restore test',true)`, [tenant,id,external]);
    }
    await client.query(`INSERT INTO marketrift.document_analyses(tenant_id,document_id,extractor_version)
      VALUES($1,$2,'synthetic-test-v1')`, [ids.tenantA,ids.documentDeleted]);
    const zeroVector = `[${Array(384).fill('0').join(',')}]`;
    await client.query(`INSERT INTO marketrift.evidence_chunks(tenant_id,source_id,product_id,
      document_id,source_type,chunk_no,content_version,text_content,content_sha256,
      embedding_model,embedding_version,synthetic,embedding)
      VALUES($1,$2,$3,$4,'b2b_review',0,'synthetic-v1','Synthetic indexed text',
      $5,'controlled-test','v1',true,$6::vector)`,
    [ids.tenantA,ids.sourceDeleted,ids.productA,ids.documentDeleted,'0'.repeat(64),zeroVector]);
    await client.query(`INSERT INTO marketrift.b2b_quality_sets(id,tenant_id,title,origin,
      version,status,created_by) VALUES($1,$2,'Synthetic restore set','synthetic_test',1,'frozen',$3)`,
    [ids.set,ids.tenantA,ids.user]);
    await client.query(`INSERT INTO marketrift.b2b_quality_items(id,tenant_id,set_id,document_id,
      source_id,content_hash,metadata_hash) VALUES($1,$2,$3,$4,$5,$6,$6)`,
    [ids.item,ids.tenantA,ids.set,ids.documentDeleted,ids.sourceDeleted,'0'.repeat(64)]);
    await client.query(`INSERT INTO marketrift.b2b_quality_reports(tenant_id,set_id,provider,
      model,status,result,created_by) VALUES($1,$2,'test','synthetic-model','completed',
      '{"example":"Synthetic report text"}'::jsonb,$3)`, [ids.tenantA,ids.set,ids.user]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
}

async function replayReview(client, event) {
  await client.query('BEGIN');
  try {
    const existing = await client.query(`SELECT id,external_key FROM marketrift.documents
      WHERE tenant_id=$1 AND source_id=$2 AND document_type='b2b_review' FOR UPDATE`,
    [event.tenant_id,event.source_id]);
    for (const row of existing.rows) {
      if (row.id !== event.document_id &&
          externalKeyHmac(key,row.external_key) !== event.external_key_hmac) continue;
      const sets = await client.query(`SELECT DISTINCT set_id FROM marketrift.b2b_quality_items
        WHERE tenant_id=$1 AND document_id=$2`, [event.tenant_id,row.id]);
      for (const item of sets.rows) {
        await client.query('DELETE FROM marketrift.b2b_quality_reports WHERE tenant_id=$1 AND set_id=$2',
          [event.tenant_id,item.set_id]);
        await client.query('DELETE FROM marketrift.b2b_quality_items WHERE tenant_id=$1 AND set_id=$2',
          [event.tenant_id,item.set_id]);
        await client.query(`UPDATE marketrift.b2b_quality_sets SET status='purged',
          title='Conjunto excluido por direitos',corpus_hash=NULL,judgment_hash=NULL
          WHERE tenant_id=$1 AND id=$2`, [event.tenant_id,item.set_id]);
      }
      for (const table of ['signal_evidence','chat_citations','insights','evidence_chunks',
        'document_embeddings','document_analyses'])
        await client.query(`DELETE FROM marketrift.${table} WHERE tenant_id=$1 AND document_id=$2`,
          [event.tenant_id,row.id]);
      await client.query('DELETE FROM marketrift.documents WHERE tenant_id=$1 AND id=$2',
        [event.tenant_id,row.id]);
    }
    const raw = await client.query(`SELECT r.import_id,r.external_key FROM marketrift.import_rows r
      JOIN marketrift.imports i ON i.tenant_id=r.tenant_id AND i.id=r.import_id
      WHERE r.tenant_id=$1 AND i.source_id=$2`, [event.tenant_id,event.source_id]);
    for (const row of raw.rows) {
      if (externalKeyHmac(key,row.external_key) !== event.external_key_hmac) continue;
      await client.query(`DELETE FROM marketrift.import_rows WHERE tenant_id=$1
        AND import_id=$2 AND external_key=$3`, [event.tenant_id,row.import_id,row.external_key]);
    }
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
}

async function rlsCount(client, tenant) {
  await client.query('BEGIN');
  try {
    await client.query('SET LOCAL ROLE marketrift_runtime');
    await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenant]);
    const result = await client.query('SELECT count(*)::int AS n FROM marketrift.documents');
    await client.query('ROLLBACK');
    return result.rows[0].n;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
}

async function oldJobRejected(connectionString, tenant, source, importId) {
  const python = resolve('apps','intelligence','.venv',
    process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const payload = JSON.stringify({ version:1, tenant_id:tenant, source_id:source,
    import_id:importId, idempotency_key:`synthetic-${importId}` });
  const code = `import asyncio,json,sys\nfrom marketrift_intelligence.ingest import ingest\n`
    + `async def main():\n try: await ingest(json.loads(sys.stdin.read()))\n`
    + ` except ValueError as error: print(str(error)); return\n raise SystemExit('old_job_accepted')\n`
    + `asyncio.run(main(), loop_factory=asyncio.SelectorEventLoop) if sys.platform=='win32' else asyncio.run(main())`;
  const result = spawnSync(python, ['-c',code], { input:payload, encoding:'utf8',
    cwd:resolve('apps','intelligence'), timeout:30_000,
    env:{...process.env,RUNTIME_DATABASE_URL:connectionString,ANALYSIS_PROVIDER:'test'},
    maxBuffer:1024*1024 });
  return result.status === 0 && /b2b_import_rows_unavailable|source does not belong/.test(result.stdout);
}

async function freePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

function launch(command,args,env) {
  const child = spawn(command,args,{ env, stdio:['ignore','pipe','pipe'] });
  child.safeOutput = '';
  child.stdout.on('data', chunk => { child.safeOutput =
    (child.safeOutput + chunk.toString()).slice(-4000); });
  child.stderr.on('data', chunk => { child.safeOutput =
    (child.safeOutput + chunk.toString()).slice(-4000); });
  child.on('error', () => {});
  return child;
}

async function waitForExit(child,ms) {
  for (let i=0;i<ms/100;i++) {
    if (child.exitCode !== null) return true;
    await new Promise(resolve => setTimeout(resolve,100));
  }
  return false;
}

async function waitForHealth(port) {
  for (let i=0;i<100;i++) {
    try { return await fetch(`http://127.0.0.1:${port}/health`); }
    catch { await new Promise(resolve => setTimeout(resolve,100)); }
  }
  throw new Error('quarantined_api_not_listening');
}

function stopProcess(child) { if (child && child.exitCode === null) child.kill(); }

function runGateCommand(command,options) {
  const result = spawnSync(process.execPath,['scripts/backup/quarantine.mjs',command], {
    env:{ ...process.env, RESTORE_TARGET_ADMIN_URL:options.adminUrl,
      RESTORE_ARCHIVE_PATH:options.archive, RESTORE_CONTAINER:options.container,
      RESTORE_JOURNAL_DIR:options.journalDir, RESTORE_JOURNAL_KEY:options.key,
      RESTORE_EXPECTED_SEQUENCE:String(options.expectedSequence),
      RESTORE_OPERATOR_ID:options.operator },
    encoding:'utf8', timeout:30_000, maxBuffer:1024*1024 });
  if (result.status !== 0) throw new Error(`restore_${command}_command_failed`);
  return JSON.parse(result.stdout);
}

let sourceStarted = false; let restoreStarted = false; let redisStarted = false;
let apiProcess; let workerProcess; let schedulerProcess; let intelligenceHttpProcess;
let sourceClient; let target; let stage = 'start';
try {
  stage = 'start_source';
  const sourcePort = startLabContainer(sourceContainer, sourcePassword, database);
  sourceStarted = true;
  const sourceUrl = url(sourcePassword,sourcePort);
  sourceClient = await connected(sourceUrl);
  stage = 'setup_schema';
  const setup = spawnSync(process.execPath,['scripts/setup-db.mjs'], { encoding:'utf8',
    timeout:90_000,maxBuffer:1024*1024,env:{...process.env,DATABASE_ADMIN_URL:sourceUrl,
      RUNTIME_DB_PASSWORD:runtimePassword,PROVISION_DB_PASSWORD:provisionPassword} });
  if (setup.status !== 0) throw new Error('isolated_schema_setup_failed');
  stage = 'seed';
  await seed(sourceClient);
  stage = 'backup_failure';
  const failedArchive = join(root,'failed.dump');
  try {
    await backup('marketrift-backup-lab-absent',database,failedArchive,key,0);
    throw new Error('missing_backup_target_accepted');
  } catch (error) {
    if (error.message === 'missing_backup_target_accepted') throw error;
    report.backup_failure_reported = true;
  }
  rmSync(failedArchive,{force:true});
  stage = 'backup';
  const manifest = await backup(sourceContainer,database,archive,key,0);
  report.backup = 'completed'; report.archive_bytes = manifest.bytes;
  stage = 'verify';
  await verify(sourceContainer,archive,key);
  report.verification = 'completed';
  const bad = join(root,'corrupted.dump');
  copyFileSync(archive,bad); copyFileSync(`${archive}.manifest.json`,`${bad}.manifest.json`);
  const fd = openSync(bad,'r+');
  try { writeSync(fd,Buffer.from([0]),0,1,0); } finally { closeSync(fd); }
  try { await verify(sourceContainer,bad,key); }
  catch (error) { report.corrupted_backup_rejected = error.message === 'verification_failed_checksum'; }
  if (!report.corrupted_backup_rejected) throw new Error('corruption_not_detected');

  stage = 'delete_after_backup';
  recordDeletion('b2b_review',ids.tenantA,ids.sourceDeleted,ids.documentDeleted,removedKey);
  await sourceClient.query('BEGIN');
  try {
    await sourceClient.query('DELETE FROM marketrift.evidence_chunks WHERE document_id=$1',
      [ids.documentDeleted]);
    await sourceClient.query('DELETE FROM marketrift.document_analyses WHERE document_id=$1',
      [ids.documentDeleted]);
    await sourceClient.query('DELETE FROM marketrift.documents WHERE id=$1', [ids.documentDeleted]);
    await sourceClient.query('DELETE FROM marketrift.import_rows WHERE import_id=$1',
      [ids.importDeleted]);
    await sourceClient.query('COMMIT');
  } catch (error) { await sourceClient.query('ROLLBACK'); throw error; }
  process.env.RUNTIME_DATABASE_URL = sourceUrl;
  process.env.PROVISION_DATABASE_URL = sourceUrl;
  stage = 'expire_rights';
  const sourceDb = new Db();
  const expiry = await new B2BRightsLifecycle(sourceDb).process(ids.tenantB,ids.sourceExpired);
  if (expiry.status !== 'completed') throw new Error('synthetic_expiry_purge_failed');
  stage = 'revoke_rights';
  await sourceClient.query(`UPDATE marketrift.sources SET enabled=false,storage_permitted=false,
    external_ai_permitted=false,b2b_deletion_status='pending',b2b_deletion_reason='revocation'
    WHERE tenant_id=$1 AND id=$2`, [ids.tenantA,ids.sourceRevoked]);
  const revocation = await new B2BRightsLifecycle(sourceDb).process(ids.tenantA,ids.sourceRevoked);
  await sourceDb.onModuleDestroy();
  if (revocation.status !== 'completed') throw new Error('synthetic_revocation_purge_failed');
  report.journal_events = readDeletionJournal(journalDir,key).length;
  if (report.journal_events !== 3) throw new Error('journal_incomplete');
  await sourceClient.end();

  stage = 'start_restore';
  const restorePort = startLabContainer(restoreContainer,restorePassword,'postgres');
  restoreStarted = true;
  const targetAdmin = `postgres://postgres:${restorePassword}@127.0.0.1:${restorePort}/postgres`;
  const targetBootstrap = await connected(targetAdmin); await targetBootstrap.end();
  stage = 'restore';
  await restore(restoreContainer,archive,key,
    { runtime:runtimePassword, provision:provisionPassword });
  report.restore = 'quarantined';
  const targetUrl = url(restorePassword,restorePort);
  const runtimeUrl = `postgres://marketrift_api_login:${runtimePassword}`
    + `@127.0.0.1:${restorePort}/${database}`;
  const provisionUrl = `postgres://marketrift_auth_login:${provisionPassword}`
    + `@127.0.0.1:${restorePort}/${database}`;
  const redisPort = startLabRedis(redisContainer);
  redisStarted = true;
  const apiPort = await freePort();
  const httpPort = await freePort();
  const safeParentEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !/(OPENAI|GITHUB|G2_|BRAVE|TOKEN|SECRET|PASSWORD|DATABASE|API_KEY|JOURNAL|PROVIDER)/i.test(name)));
  const serviceEnv = { ...safeParentEnv, RUNTIME_DATABASE_URL:runtimeUrl,
    PROVISION_DATABASE_URL:provisionUrl, RESTORE_GATE_REQUIRED:'1',
    REDIS_URL:`redis://127.0.0.1:${redisPort}`, API_PORT:String(apiPort),
    SESSION_SECRET:randomBytes(32).toString('hex'), WEB_ORIGIN:'http://localhost:3000',
    EMBEDDING_PROVIDER:'controlled', ANALYSIS_PROVIDER:'test' };
  stage = 'blocked_processes';
  apiProcess = launch(process.execPath,['apps/api/dist/main.js'],serviceEnv);
  const healthBefore = await waitForHealth(apiPort);
  const blockedRoute = await fetch(`http://127.0.0.1:${apiPort}/v1/auth/session`);
  report.api_blocked = healthBefore.status === 503 && blockedRoute.status === 503 &&
    (await blockedRoute.json()).code === 'restoration_quarantine';
  const python = resolve('apps','intelligence','.venv',
    process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  workerProcess = launch(python,['-m','marketrift_intelligence.worker'],serviceEnv);
  report.worker_blocked = await waitForExit(workerProcess,10000) && workerProcess.exitCode !== 0 &&
    workerProcess.safeOutput.includes('restore_quarantined');
  stopProcess(workerProcess); workerProcess = undefined;
  intelligenceHttpProcess = launch(python,['-m','uvicorn','marketrift_intelligence.http:app',
    '--host','127.0.0.1','--port',String(httpPort)],serviceEnv);
  report.intelligence_http_blocked = (await waitForHealth(httpPort)).status === 503;
  schedulerProcess = launch(process.execPath,['apps/api/dist/page-scheduler-main.js'],serviceEnv);
  report.scheduler_blocked = await waitForExit(schedulerProcess,5000) && schedulerProcess.exitCode !== 0 &&
    schedulerProcess.safeOutput.includes('restore_quarantined');
  stopProcess(schedulerProcess); schedulerProcess = undefined;
  if (!report.api_blocked || !report.worker_blocked || !report.scheduler_blocked ||
      !report.intelligence_http_blocked)
    throw new Error('quarantine_process_gate_failed');
  target = await connected(targetUrl);
  stage = 'reconcile';
  const before = await target.query(`SELECT count(*)::int AS n FROM marketrift.documents
    WHERE id=ANY($1::uuid[])`, [[ids.documentDeleted,ids.documentExpired,ids.documentRevoked]]);
  if (before.rows[0].n !== 3) throw new Error('historical_text_not_present_in_isolated_restore');
  const auditOptions = { adminUrl:targetUrl, archive, container:restoreContainer,
    journalDir, key, expectedSequence:3, operator:'synthetic-lab' };
  try { await auditDestination(auditOptions); throw new Error('premature_audit_accepted'); }
  catch (error) { if (error.message === 'premature_audit_accepted') throw error; }
  report.quarantine = 'blocked_pending_deletions_and_expired_rights';
  report.restore_initially_blocked = true;
  for (const event of readDeletionJournal(journalDir,key)) {
    if (event.kind === 'b2b_review') await replayReview(target,event);
    else {
      await target.query(`UPDATE marketrift.sources SET enabled=false,storage_permitted=false,
        external_ai_permitted=false,b2b_deletion_status='pending',b2b_deletion_reason='revocation'
        WHERE tenant_id=$1 AND id=$2 AND b2b_deletion_status<>'completed'`,
      [event.tenant_id,event.source_id]);
      process.env.RUNTIME_DATABASE_URL = targetUrl;
      process.env.PROVISION_DATABASE_URL = targetUrl;
      const restoreDb = new Db();
      const result = await new B2BRightsLifecycle(restoreDb).process(event.tenant_id,event.source_id);
      await restoreDb.onModuleDestroy();
      if (!['completed','not_due'].includes(result.status)) throw new Error('source_replay_failed');
    }
  }
  stage = 'audit';
  const removed = await target.query(`SELECT count(*)::int AS n FROM marketrift.documents
    WHERE id=ANY($1::uuid[])`, [[ids.documentDeleted,ids.documentExpired,ids.documentRevoked]]);
  const raw = await target.query(`SELECT count(*)::int AS n FROM marketrift.import_rows
    WHERE import_id=ANY($1::uuid[])`, [[ids.importDeleted,ids.importExpired,ids.importRevoked]]);
  const leftovers = await target.query(`SELECT
    (SELECT count(*) FROM marketrift.document_analyses WHERE document_id=$1)::int AS analyses,
    (SELECT count(*) FROM marketrift.evidence_chunks WHERE document_id=$1)::int AS chunks,
    (SELECT count(*) FROM marketrift.b2b_quality_items WHERE document_id=$1)::int AS items,
    (SELECT count(*) FROM marketrift.b2b_quality_reports WHERE set_id=$2)::int AS reports`,
  [ids.documentDeleted,ids.set]);
  const schema = await target.query(`SELECT
    to_regclass('marketrift.b2b_rights_events') IS NOT NULL AS rights_events,
    to_regclass('marketrift.evidence_chunks') IS NOT NULL AS chunks,
    EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='marketrift'
      AND table_name='sources' AND column_name='github_monitor_generation') AS latest_schema`);
  report.rls = await rlsCount(target,ids.tenantA) === 1 && await rlsCount(target,ids.tenantB) === 1;
  report.old_jobs_rejected = await oldJobRejected(targetUrl,ids.tenantA,ids.sourceDeleted,
    ids.importDeleted) && await oldJobRejected(targetUrl,ids.tenantB,ids.sourceExpired,ids.importExpired)
    && await oldJobRejected(targetUrl,ids.tenantA,ids.sourceRevoked,ids.importRevoked);
  if (removed.rows[0].n || raw.rows[0].n || Object.values(leftovers.rows[0]).some(Boolean)
      || !Object.values(schema.rows[0]).every(Boolean) || !report.rls || !report.old_jobs_rejected)
    throw new Error('quarantine_audit_failed');
  if (runGateCommand('audit',auditOptions).status !== 'audited')
    throw new Error('restore_audit_command_failed');
  if ((await auditDestination(auditOptions)).status !== 'audited')
    throw new Error('restore_audit_repeat_failed');
  const firstEvent = readdirSync(journalDir).find(name => /^000000000001-.*\.json$/.test(name));
  if (!firstEvent) throw new Error('journal_first_event_missing');
  const eventPath = join(journalDir,firstEvent);
  const hiddenPath = `${eventPath}.missing`;
  renameSync(eventPath,hiddenPath);
  try {
    await releaseDestination(auditOptions);
  } catch (error) {
    report.missing_event_release_rejected = /journal_sequence_incomplete|sequence gap/.test(error.message);
  } finally { renameSync(hiddenPath,eventPath); }
  if (!report.missing_event_release_rejected) throw new Error('missing_event_release_accepted');
  const hiddenJournal = `${journalDir}.unavailable`;
  renameSync(journalDir,hiddenJournal);
  try { await releaseDestination(auditOptions); }
  catch { report.unavailable_journal_rejected = true; }
  finally { renameSync(hiddenJournal,journalDir); }
  if (!report.unavailable_journal_rejected) throw new Error('unavailable_journal_accepted');
  const headPath = join(journalDir,'head.json');
  const originalHead = readFileSync(headPath,'utf8');
  writeFileSync(headPath,originalHead.replace(/"signature":"[0-9a-f]{64}"/,
    `"signature":"${'0'.repeat(64)}"`));
  try { await releaseDestination(auditOptions); }
  catch { report.invalid_signature_rejected = true; }
  finally { writeFileSync(headPath,originalHead); }
  if (!report.invalid_signature_rejected) throw new Error('invalid_signature_release_accepted');
  try { await releaseDestination({ ...auditOptions,
    adminUrl:targetUrl.replace(`/${database}`, '/marketrift') }); }
  catch (error) {
    report.real_release_blocked = error.message ===
      'real_restore_release_requires_independent_immutable_journal';
  }
  if (!report.real_release_blocked) throw new Error('real_release_without_journal_accepted');
  const released = runGateCommand('release',auditOptions);
  const repeated = await releaseDestination(auditOptions);
  if (released.status !== 'released' || repeated.status !== 'already_released')
    throw new Error('restore_release_not_idempotent');
  const trailUrl = `postgres://postgres:${restorePassword}@127.0.0.1:${restorePort}/postgres`;
  const trailClient = await connected(trailUrl);
  const trail = await trailClient.query(`SELECT kind,operator_id FROM public.marketrift_restore_gate_events
    ORDER BY id`);
  await trailClient.end();
  report.audit_trail = trail.rows.length === 2 &&
    trail.rows[0].kind === 'audited' && trail.rows[1].kind === 'released' &&
    trail.rows.every(row => row.operator_id === 'synthetic-lab');
  if (!report.audit_trail) throw new Error('restore_audit_trail_invalid');
  const healthAfter = await fetch(`http://127.0.0.1:${apiPort}/health`);
  const httpHealthAfter = await fetch(`http://127.0.0.1:${httpPort}/health`);
  const openRoute = await fetch(`http://127.0.0.1:${apiPort}/v1/auth/session`);
  workerProcess = launch(python,['-m','marketrift_intelligence.worker'],serviceEnv);
  schedulerProcess = launch(process.execPath,['apps/api/dist/page-scheduler-main.js'],serviceEnv);
  await new Promise(resolve => setTimeout(resolve,3500));
  report.processes_released = healthAfter.status === 200 && httpHealthAfter.status === 200 &&
    openRoute.status === 401 &&
    workerProcess.exitCode === null && schedulerProcess.exitCode === null &&
    schedulerProcess.safeOutput.includes('MarketRift scheduler started');
  if (!report.processes_released) throw new Error('released_processes_not_operating');
  report.quarantine = 'checked_synthetic_only';
  report.status = 'passed';
  await target.end();
} catch (error) {
  report.status = 'failed'; report.error_code = /^[a-z0-9_]+$/.test(error.message)
    ? error.message : error.code ?? 'lab_failure';
  report.stage = stage;
  process.exitCode = 1;
} finally {
  stopProcess(apiProcess); stopProcess(workerProcess); stopProcess(schedulerProcess);
  stopProcess(intelligenceHttpProcess);
  if (target) await target.end().catch(() => {});
  if (sourceClient) await sourceClient.end().catch(() => {});
  if (redisStarted) { try { stopLabContainer(redisContainer); } catch { report.cleanup = 'failed'; } }
  if (restoreStarted) { try { stopLabContainer(restoreContainer); } catch { report.cleanup = 'failed'; } }
  if (sourceStarted) { try { stopLabContainer(sourceContainer); } catch { report.cleanup = 'failed'; } }
  if (report.cleanup === 'failed') { report.status = 'failed'; process.exitCode = 1; }
  writeFileSync(join(root,'report.json'),JSON.stringify(report,null,2),{mode:0o600});
  console.log(JSON.stringify(report));
}
