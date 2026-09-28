/** Restore gate for isolated synthetic drills. Real release has no trusted external anchor yet. */
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { verify } from './ops.mjs';

const { Client } = pg;
const labName = /^marketrift_backup_lab_[0-9a-f]{8}$/;

function databaseName(connectionString) {
  return decodeURIComponent(new URL(connectionString).pathname.slice(1));
}

function controlUrl(connectionString) {
  const url = new URL(connectionString);
  url.pathname = '/postgres';
  return url.toString();
}

function requireLab(connectionString) {
  if (!labName.test(databaseName(connectionString)))
    throw new Error('real_restore_release_requires_independent_immutable_journal');
}

function requireOperator(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_.-]{3,80}$/.test(value))
    throw new Error('restore_operator_required');
}

async function withClient(url, work) {
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 3000 });
  await client.connect();
  try { return await work(client); }
  finally { await client.end(); }
}

async function gate(client, name) {
  const result = await client.query(`SELECT database_name,archive_sha256,state,
    audit_digest,audit_sequence FROM public.marketrift_restore_gate WHERE id=true`);
  const row = result.rows[0];
  if (!row || row.database_name !== name) throw new Error('restore_gate_identity_mismatch');
  return row;
}

async function journal(directory, key, expectedSequence) {
  const { readDeletionJournal } = await import('../../apps/api/dist/deletion-journal.js');
  const events = readDeletionJournal(directory, key);
  if (!Number.isSafeInteger(expectedSequence) || expectedSequence < 0 ||
      events.length !== expectedSequence) throw new Error('journal_sequence_incomplete');
  return events;
}

async function checkRightsAndDeletions(client, events, key) {
  const synthetic = await client.query(`SELECT
    NOT EXISTS(SELECT 1 FROM marketrift.documents WHERE synthetic=false) AS documents,
    NOT EXISTS(SELECT 1 FROM marketrift.tenants WHERE name NOT LIKE 'Synthetic %') AS tenants,
    NOT EXISTS(SELECT 1 FROM marketrift.users WHERE email NOT LIKE '%@example.invalid') AS users`);
  if (!Object.values(synthetic.rows[0]).every(Boolean))
    throw new Error('real_restore_release_requires_independent_immutable_journal');
  const schema = await client.query(`SELECT
    to_regclass('marketrift.b2b_rights_events') IS NOT NULL AS rights_events,
    to_regclass('marketrift.evidence_chunks') IS NOT NULL AS chunks,
    EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='marketrift'
      AND table_name='sources' AND column_name='github_monitor_generation') AS latest_schema`);
  if (!Object.values(schema.rows[0]).every(Boolean)) throw new Error('restore_schema_incompatible');
  for (const event of events) {
    const source = await client.query(`SELECT tenant_id FROM marketrift.sources WHERE id=$1`,
      [event.source_id]);
    if (source.rows[0]?.tenant_id !== event.tenant_id)
      throw new Error('journal_tenant_source_mismatch');
    if (event.kind === 'b2b_source') {
      const remaining = await client.query(`SELECT
        (SELECT count(*) FROM marketrift.documents WHERE tenant_id=$1 AND source_id=$2)::int AS documents,
        (SELECT count(*) FROM marketrift.import_rows r JOIN marketrift.imports i
           ON i.tenant_id=r.tenant_id AND i.id=r.import_id
           WHERE i.tenant_id=$1 AND i.source_id=$2)::int AS raw_rows`,
      [event.tenant_id,event.source_id]);
      if (remaining.rows[0].documents || remaining.rows[0].raw_rows)
        throw new Error('deleted_source_text_restored');
    } else {
      const remaining = await client.query(`SELECT
        (SELECT count(*) FROM marketrift.documents WHERE tenant_id=$1 AND id=$2)::int AS documents,
        (SELECT count(*) FROM marketrift.evidence_chunks WHERE tenant_id=$1 AND document_id=$2)::int AS chunks,
        (SELECT count(*) FROM marketrift.document_analyses WHERE tenant_id=$1 AND document_id=$2)::int AS analyses,
        (SELECT count(*) FROM marketrift.b2b_quality_items WHERE tenant_id=$1 AND document_id=$2)::int AS items`,
      [event.tenant_id,event.document_id]);
      if (Object.values(remaining.rows[0]).some(Boolean))
        throw new Error('deleted_review_text_restored');
      const raw = await client.query(`SELECT r.external_key FROM marketrift.import_rows r
        JOIN marketrift.imports i ON i.tenant_id=r.tenant_id AND i.id=r.import_id
        WHERE i.tenant_id=$1 AND i.source_id=$2`, [event.tenant_id,event.source_id]);
      const { externalKeyHmac } = await import('../../apps/api/dist/deletion-journal.js');
      if (raw.rows.some(row => externalKeyHmac(key,row.external_key) === event.external_key_hmac))
        throw new Error('deleted_review_raw_text_restored');
    }
  }
  const reports = await client.query(`SELECT count(*)::int AS n FROM marketrift.b2b_quality_reports r
    JOIN marketrift.b2b_quality_sets s ON s.tenant_id=r.tenant_id AND s.id=r.set_id
    WHERE s.status='purged'`);
  if (reports.rows[0].n) throw new Error('purged_quality_report_restored');
  const forbidden = await client.query(`SELECT count(*)::int AS n FROM marketrift.documents d
    JOIN marketrift.sources s ON s.tenant_id=d.tenant_id AND s.id=d.source_id
    WHERE s.source_type='b2b_csv_review' AND (
      s.b2b_deletion_status IN ('pending','failed','completed') OR
      (s.access_environment='production' AND s.b2b_retention_policy='delete_on_expiry'
       AND s.rights_expires_at<=now()))`);
  if (forbidden.rows[0].n) throw new Error('expired_or_revoked_text_restored');
  const pending = await client.query(`SELECT count(*)::int AS n FROM marketrift.imports i
    JOIN marketrift.sources s ON s.tenant_id=i.tenant_id AND s.id=i.source_id
    WHERE i.status IN ('queued','pending','processing') AND s.source_type='b2b_csv_review'
      AND (s.storage_permitted=false OR s.rights_expires_at<=now())`);
  if (pending.rows[0].n) throw new Error('old_jobs_can_recreate_text');
  const tenants = await client.query('SELECT id FROM marketrift.tenants ORDER BY id');
  if (!tenants.rows.length) throw new Error('restore_tenants_missing');
  for (const tenant of tenants.rows) {
    await client.query('BEGIN');
    try {
      await client.query('SET LOCAL ROLE marketrift_runtime');
      await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenant.id]);
      const visible = await client.query('SELECT DISTINCT tenant_id FROM marketrift.documents');
      if (visible.rows.some(row => row.tenant_id !== tenant.id))
        throw new Error('restore_rls_failed');
    } finally { await client.query('ROLLBACK'); }
  }
  return tenants.rows.length;
}

function digest(manifest, events) {
  return createHash('sha256').update(JSON.stringify({ archive:manifest.sha256,
    sequence:events.length, events:events.map(event => [event.sequence,event.kind,event.tenant_id,
      event.source_id,event.document_id ?? null]) })).digest('hex');
}

export async function auditDestination(options) {
  requireLab(options.adminUrl);
  requireOperator(options.operator);
  const name = databaseName(options.adminUrl);
  const manifest = await verify(options.container,options.archive,options.key);
  if (manifest.database !== name) throw new Error('restore_archive_identity_mismatch');
  const events = await journal(options.journalDir,options.key,options.expectedSequence);
  const control = await withClient(controlUrl(options.adminUrl), client => gate(client,name));
  if (control.archive_sha256 !== manifest.sha256 || control.state !== 'quarantined')
    throw new Error('restore_gate_state_mismatch');
  const tenants = await withClient(options.adminUrl,
    client => checkRightsAndDeletions(client,events,options.key));
  const auditDigest = digest(manifest,events);
  await withClient(controlUrl(options.adminUrl), async client => {
    await client.query('BEGIN');
    try {
      const updated = await client.query(`UPDATE public.marketrift_restore_gate
        SET audit_digest=$1,audit_sequence=$2,audited_at=now(),audited_by=$4
        WHERE id=true AND state='quarantined' AND archive_sha256=$3`,
      [auditDigest,events.length,manifest.sha256,options.operator]);
      if (updated.rowCount !== 1) throw new Error('restore_gate_state_mismatch');
      await client.query(`INSERT INTO public.marketrift_restore_gate_events
        (kind,audit_digest,operator_id) VALUES('audited',$1,$2)
        ON CONFLICT (kind,audit_digest) DO NOTHING`, [auditDigest,options.operator]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
  });
  return { status:'audited', sequence:events.length, tenants, gate:'quarantined' };
}

export async function releaseDestination(options) {
  requireLab(options.adminUrl);
  requireOperator(options.operator);
  const name = databaseName(options.adminUrl);
  const manifest = await verify(options.container,options.archive,options.key);
  if (manifest.database !== name) throw new Error('restore_archive_identity_mismatch');
  const events = await journal(options.journalDir,options.key,options.expectedSequence);
  const auditDigest = digest(manifest,events);
  await withClient(options.adminUrl, client => checkRightsAndDeletions(client,events,options.key));
  return withClient(controlUrl(options.adminUrl), async client => {
    await client.query('BEGIN');
    try {
      const control = await client.query(`SELECT database_name,archive_sha256,state,audit_digest,
        audit_sequence FROM public.marketrift_restore_gate WHERE id=true FOR UPDATE`);
      const row = control.rows[0];
      if (!row || row.database_name !== name || row.archive_sha256 !== manifest.sha256 ||
          row.audit_digest !== auditDigest || Number(row.audit_sequence) !== events.length)
        throw new Error('restore_audit_required');
      if (row.state === 'released') { await client.query('COMMIT'); return { status:'already_released' }; }
      if (row.state !== 'quarantined') throw new Error('restore_gate_state_mismatch');
      // CONNECT is granted only in the same transaction that changes gate state.
      await client.query(`GRANT CONNECT ON DATABASE ${name} TO marketrift_api_login,marketrift_auth_login`);
      await client.query(`UPDATE public.marketrift_restore_gate SET state='released',
        released_at=now(),released_by=$1 WHERE id=true`, [options.operator]);
      await client.query(`INSERT INTO public.marketrift_restore_gate_events
        (kind,audit_digest,operator_id) VALUES('released',$1,$2)`, [auditDigest,options.operator]);
      await client.query('COMMIT');
      return { status:'released', sequence:events.length };
    } catch (error) { await client.query('ROLLBACK'); throw error; }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const command = process.argv[2];
  const options = { adminUrl: process.env.RESTORE_TARGET_ADMIN_URL,
    archive: process.env.RESTORE_ARCHIVE_PATH, container: process.env.RESTORE_CONTAINER,
    journalDir: process.env.RESTORE_JOURNAL_DIR, key: process.env.RESTORE_JOURNAL_KEY,
    expectedSequence: Number(process.env.RESTORE_EXPECTED_SEQUENCE),
    operator: process.env.RESTORE_OPERATOR_ID };
  try {
    const result = command === 'audit' ? await auditDestination(options)
      : command === 'release' ? await releaseDestination(options) : null;
    if (!result) throw new Error('restore_command_invalid');
    console.log(JSON.stringify(result));
  } catch (error) {
    const safeCode = error instanceof Error && /^[a-z0-9_]+$/.test(error.message)
      ? error.message : 'restore_operation_failed';
    console.error(JSON.stringify({ status:'blocked', code:safeCode }));
    process.exitCode = 1;
  }
}
