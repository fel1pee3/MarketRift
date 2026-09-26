import { ConflictException } from '@nestjs/common';
import { Worker } from 'bullmq';
import type { QueryResultRow } from 'pg';
import { Db } from './db';
import { Jobs, redisConnection } from './queue';
import { reconcileSignals } from './reviewable-signals';
import { makeSignalJob, parseSignalJob } from './signal-job';

type Due = QueryResultRow & { tenant_id: string; source_id: string; requested_revision: string };

export class SignalScheduler {
  private worker?: Worker;
  constructor(private readonly db: Db, private readonly jobs: Jobs) {}

  async tick(): Promise<'idle' | 'published' | 'publish_failed'> {
    const testTenant = process.env.MARKETRIFT_TEST_MODE === '1'
      ? process.env.PAGE_SCHEDULER_TEST_TENANT_ID : undefined;
    const client = await this.db.provisioning.connect();
    let due: Due | undefined;
    try {
      await client.query('BEGIN');
      const result = await client.query<Due>(`SELECT tenant_id,source_id,requested_revision
        FROM marketrift.signal_reconcile_sources
        WHERE requested_revision>processed_revision AND next_attempt_at<=now()
          ${testTenant ? 'AND tenant_id=$1' : ''}
        ORDER BY next_attempt_at,updated_at,source_id LIMIT 1 FOR UPDATE SKIP LOCKED`,
      testTenant ? [testTenant] : []);
      due = result.rows[0];
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally { client.release(); }
    if (!due) return 'idle';
    try {
      await this.jobs.publishSignal(makeSignalJob(due.tenant_id, due.source_id, due.requested_revision));
      return 'published';
    } catch { return 'publish_failed'; } // Durable row remains due for the next tick.
  }

  startWorker(): void {
    if (this.worker) return;
    this.worker = new Worker('signal-reconcile', async bullJob => {
      const job = parseSignalJob(bullJob.data);
      const testTenant = process.env.MARKETRIFT_TEST_MODE === '1'
        ? process.env.PAGE_SCHEDULER_TEST_TENANT_ID : undefined;
      if (testTenant && job.tenant_id !== testTenant) throw new Error('test_tenant_scope');
      try {
        await this.db.tenant(job.tenant_id, async client => {
          await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 7176166010))',
            [job.tenant_id]);
          const rows = await this.db.rows<Due & { processed_revision: string }>(client,
            `SELECT ledger.tenant_id,ledger.source_id,ledger.requested_revision,ledger.processed_revision
              FROM marketrift.signal_reconcile_sources ledger
              JOIN marketrift.sources s ON s.tenant_id=ledger.tenant_id AND s.id=ledger.source_id
              JOIN marketrift.products p ON p.tenant_id=s.tenant_id AND p.id=s.product_id
              WHERE ledger.tenant_id=$1 AND ledger.source_id=$2 FOR UPDATE OF ledger`,
            [job.tenant_id, job.source_id]);
          const row = rows[0];
          if (!row) throw new Error('source_not_visible');
          if (BigInt(row.requested_revision) <= BigInt(row.processed_revision)) return;
          await reconcileSignals(this.db, client, job.tenant_id);
          await client.query(`UPDATE marketrift.signal_reconcile_sources SET
            processed_revision=$3,last_reconciled_at=now(),last_error=NULL,attempts=0,
            next_attempt_at=now() WHERE tenant_id=$1 AND source_id=$2`,
          [job.tenant_id, job.source_id, row.requested_revision]);
        });
      } catch (error) {
        const code = error instanceof ConflictException ? 'fact_limit_exceeded'
          : error instanceof Error && error.message === 'source_not_visible' ? 'source_not_visible'
          : 'reconciliation_failed';
        await this.db.tenant(job.tenant_id, async client => {
          await client.query(`UPDATE marketrift.signal_reconcile_sources SET
            last_error=$3, attempts=attempts+1,
            next_attempt_at=now()+least(300,power(2,least(attempts,8))::integer)*interval '1 second',
            updated_at=now() WHERE tenant_id=$1 AND source_id=$2
            AND requested_revision>processed_revision`, [job.tenant_id, job.source_id, code]);
        }).catch(() => undefined);
        throw error;
      }
    }, { connection: { ...redisConnection(), maxRetriesPerRequest: null }, concurrency: 1 });
    this.worker.on('error', () => { /* The durable row exposes pending work; no sensitive logs. */ });
    this.worker.on('failed', () => { /* Retry via BullMQ and the durable dispatcher. */ });
  }

  async close(): Promise<void> { await this.worker?.close(); }
}
