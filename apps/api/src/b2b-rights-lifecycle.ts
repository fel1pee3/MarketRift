import { Injectable } from '@nestjs/common';
import type { QueryResultRow } from 'pg';
import { Db } from './db';
import { recordDeletionForOperation } from './deletion-journal';

type Source = QueryResultRow & { id: string; tenant_id: string; source_type: string;
  access_environment: string | null; b2b_retention_policy: string; b2b_deletion_status: string;
  b2b_deletion_reason: string | null; rights_expires_at: Date | null };
export type PurgeResult = { status: 'completed' | 'failed' | 'not_due';
  documents_removed: number; import_rows_removed: number; error_code: string | null };

function errorCode(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  if (error instanceof Error && error.message.startsWith('Deletion journal'))
    return 'deletion_journal_unavailable';
  if (error instanceof Error && error.message.startsWith('external_'))
    return 'deletion_journal_unavailable';
  if (['EACCES', 'ENOENT', 'ENOSPC', 'EROFS'].includes(code))
    return 'deletion_journal_unavailable';
  if (code === '23503') return 'foreign_key_dependency';
  if (code === '42501') return 'database_permission_denied';
  if (code === '40P01') return 'database_deadlock';
  if (code === '55P03') return 'database_lock_timeout';
  return 'purge_failed';
}

/** A source row is the durable request. Every deletion and its verification commit together. */
@Injectable()
export class B2BRightsLifecycle {
  constructor(private readonly db: Db) {}

  async tick(): Promise<'idle' | PurgeResult> {
    const testTenant = process.env.MARKETRIFT_TEST_MODE === '1'
      ? process.env.B2B_RIGHTS_TEST_TENANT_ID : undefined;
    const due = await this.db.provisioning.query<{ id: string; tenant_id: string }>(`
      SELECT id,tenant_id FROM marketrift.sources WHERE source_type='b2b_csv_review'
      AND (b2b_deletion_next_attempt_at IS NULL OR b2b_deletion_next_attempt_at <= now())
      AND ((b2b_deletion_status IN ('pending','failed')) OR
        (b2b_deletion_status='not_required' AND access_environment='production'
          AND b2b_retention_policy='delete_on_expiry' AND rights_expires_at <= now()))
      ${testTenant ? 'AND tenant_id=$1' : ''}
      ORDER BY coalesce(b2b_deletion_requested_at,rights_expires_at),id LIMIT 1`,
    testTenant ? [testTenant] : []);
    const source = due.rows[0];
    return source ? this.process(source.tenant_id, source.id) : 'idle';
  }

  async process(tenantId: string, sourceId: string): Promise<PurgeResult> {
    try {
      return await this.db.tenant(tenantId, async client => {
        const [source] = await this.db.rows<Source>(client, `SELECT id,tenant_id,source_type,
          access_environment,b2b_retention_policy,b2b_deletion_status,b2b_deletion_reason,
          rights_expires_at FROM marketrift.sources WHERE id=$1 AND source_type='b2b_csv_review'
          FOR UPDATE`, [sourceId]);
        if (!source) return { status: 'not_due', documents_removed: 0,
          import_rows_removed: 0, error_code: null };
        const expiryDue = source.access_environment === 'production' &&
          source.b2b_retention_policy === 'delete_on_expiry' && !!source.rights_expires_at &&
          source.rights_expires_at <= new Date();
        const revocationDue = source.b2b_deletion_reason === 'revocation' &&
          ['pending','failed'].includes(source.b2b_deletion_status);
        if (source.b2b_deletion_status === 'completed' || (!expiryDue && !revocationDue))
          return { status: 'not_due', documents_removed: 0, import_rows_removed: 0, error_code: null };
        const reason = revocationDue ? 'revocation' : 'expiry';
        await recordDeletionForOperation('b2b_source', tenantId, sourceId);
        // Ingest, analysis and indexing lock this source before publishing content.
        // The lock serializes those jobs with the complete purge transaction.
        const setIds = await this.db.rows<{ set_id: string }>(client,
          'SELECT DISTINCT set_id FROM marketrift.b2b_quality_items WHERE source_id=$1', [sourceId]);
        if (setIds.length) {
          const ids = setIds.map(row => row.set_id);
          await client.query('DELETE FROM marketrift.b2b_quality_reports WHERE set_id=ANY($1::uuid[])', [ids]);
          await client.query('DELETE FROM marketrift.b2b_quality_items WHERE source_id=$1', [sourceId]);
          await client.query(`UPDATE marketrift.b2b_quality_sets SET status='purged',
            title='Conjunto excluído por direitos',corpus_hash=NULL,judgment_hash=NULL
            WHERE id=ANY($1::uuid[])`, [ids]);
        }
        const docs = 'SELECT id FROM marketrift.documents WHERE source_id=$1';
        await client.query(`DELETE FROM marketrift.signal_evidence WHERE document_id IN (${docs})`, [sourceId]);
        await client.query(`DELETE FROM marketrift.chat_citations WHERE document_id IN (${docs})`, [sourceId]);
        await client.query(`DELETE FROM marketrift.insights WHERE document_id IN (${docs})`, [sourceId]);
        await client.query(`DELETE FROM marketrift.evidence_chunks WHERE source_id=$1`, [sourceId]);
        await client.query(`DELETE FROM marketrift.document_embeddings WHERE document_id IN (${docs})`, [sourceId]);
        await client.query(`DELETE FROM marketrift.document_analyses WHERE document_id IN (${docs})`, [sourceId]);
        const deletedDocuments = await client.query('DELETE FROM marketrift.documents WHERE source_id=$1', [sourceId]);
        const deletedRows = await client.query(`DELETE FROM marketrift.import_rows r
          USING marketrift.imports i WHERE r.tenant_id=i.tenant_id AND r.import_id=i.id
          AND i.source_id=$1`, [sourceId]);
        await client.query(`UPDATE marketrift.imports SET status='failed',
          last_error='b2b_rights_purged',finished_at=now() WHERE source_id=$1
          AND status IN ('pending','queued','processing')`, [sourceId]);
        await client.query(`UPDATE marketrift.sources SET storage_permitted=false,
          external_ai_permitted=false,b2b_rights_generation=b2b_rights_generation+1,
          b2b_deletion_status='completed',b2b_deletion_reason=$2,
          b2b_deletion_requested_at=coalesce(b2b_deletion_requested_at,now()),
          b2b_deletion_completed_at=now(),b2b_deletion_next_attempt_at=NULL,
          b2b_deletion_error=NULL,b2b_deletion_attempts=b2b_deletion_attempts+1,
          b2b_deleted_documents=b2b_deleted_documents+$3,
          b2b_deleted_import_rows=b2b_deleted_import_rows+$4 WHERE id=$1`,
        [sourceId,reason,deletedDocuments.rowCount ?? 0,deletedRows.rowCount ?? 0]);
        await client.query(`INSERT INTO marketrift.b2b_rights_events
          (tenant_id,source_id,event_kind,retention_policy,rights_expires_at,
            documents_removed,import_rows_removed)
          VALUES ($1,$2,'deletion_completed',$3,$4,$5,$6)`,
        [tenantId,sourceId,source.b2b_retention_policy,source.rights_expires_at,
          deletedDocuments.rowCount ?? 0,deletedRows.rowCount ?? 0]);
        return { status: 'completed', documents_removed: deletedDocuments.rowCount ?? 0,
          import_rows_removed: deletedRows.rowCount ?? 0, error_code: null };
      });
    } catch (error) {
      const code = errorCode(error);
      // The failed transaction rolled back every deletion. Persist a safe reason and retry time.
      await this.db.tenant(tenantId, async client => {
        const [source] = await this.db.rows<Source>(client, `SELECT id,tenant_id,source_type,
          access_environment,b2b_retention_policy,b2b_deletion_status,b2b_deletion_reason,
          rights_expires_at FROM marketrift.sources WHERE id=$1 AND source_type='b2b_csv_review'
          FOR UPDATE`, [sourceId]);
        if (!source || source.b2b_deletion_status === 'completed') return;
        if (source.b2b_deletion_reason !== 'revocation' &&
          !(source.access_environment === 'production' && source.b2b_retention_policy === 'delete_on_expiry'
            && source.rights_expires_at && source.rights_expires_at <= new Date())) return;
        await client.query(`UPDATE marketrift.sources SET b2b_deletion_status='failed',
          b2b_deletion_requested_at=coalesce(b2b_deletion_requested_at,now()),
          b2b_deletion_reason=coalesce(b2b_deletion_reason,'expiry'),
          b2b_deletion_error=$2,b2b_deletion_attempts=b2b_deletion_attempts+1,
          b2b_deletion_next_attempt_at=now()+least(300,power(2,least(b2b_deletion_attempts,8))::integer)*interval '1 second'
          WHERE id=$1`, [sourceId,code]);
        await client.query(`INSERT INTO marketrift.b2b_rights_events
          (tenant_id,source_id,event_kind,retention_policy,rights_expires_at,error_code)
          VALUES ($1,$2,'deletion_failed',$3,$4,$5)`,
        [tenantId,sourceId,source.b2b_retention_policy,source.rights_expires_at,code]);
      });
      return { status: 'failed', documents_removed: 0, import_rows_removed: 0, error_code: code };
    }
  }
}
