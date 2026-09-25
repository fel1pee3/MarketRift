import { Injectable } from '@nestjs/common';
import type { PoolClient, QueryResultRow } from 'pg';
import { Db } from './db';
import { Jobs } from './queue';
import { makeWebPageJob } from './web-page-job';

type Pending = QueryResultRow & { id: string; tenant_id: string; source_id: string };
const GLOBAL_PAGE_CHECKS_PER_MINUTE = 6;

/** A database-backed dispatcher. Row/advisory locks coordinate independent processes. */
@Injectable()
export class PageScheduler {
  constructor(private readonly db: Db, private readonly jobs: Jobs) {}

  async tick(): Promise<'idle' | 'locked' | 'recovered' | 'scheduled' | 'limited'> {
    const client = await this.db.provisioning.connect();
    const testTenant = process.env.MARKETRIFT_TEST_MODE === '1' ? process.env.PAGE_SCHEDULER_TEST_TENANT_ID : undefined;
    const scope = testTenant ? [testTenant] : [];
    let pending: Pending | undefined;
    let outcome: 'idle' | 'locked' | 'recovered' | 'scheduled' | 'limited' = 'idle';
    try {
      await client.query('BEGIN');
      const lock = await client.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_xact_lock(7176166009::bigint) AS locked');
      if (!lock.rows[0]?.locked) {
        await client.query('ROLLBACK');
        return 'locked';
      }

      // A process can stop after committing a run but before publishing its job.
      const oldPending = await client.query<Pending>(
        "SELECT r.id, r.tenant_id, r.source_id FROM marketrift.source_runs r "
        + 'JOIN marketrift.sources s ON s.tenant_id = r.tenant_id AND s.id = r.source_id '
        + "WHERE r.run_kind = 'web_page' AND r.status = 'pending' "
        + "AND s.monitoring_enabled AND s.enabled AND r.started_at < now() - interval '15 seconds' "
        + (testTenant ? 'AND r.tenant_id = $1 ' : '')
        + 'ORDER BY r.started_at LIMIT 1 FOR UPDATE OF r SKIP LOCKED', scope);
      if (oldPending.rows[0]) {
        pending = oldPending.rows[0]; outcome = 'recovered';
      } else {
        await this.expireOneStaleRun(client, testTenant);
        const volume = await client.query<{ count: number }>(
          "SELECT count(*)::integer AS count FROM marketrift.source_runs "
          + "WHERE run_kind = 'web_page' AND started_at > now() - interval '1 minute' "
          + (testTenant ? 'AND tenant_id = $1' : ''), scope);
        if ((volume.rows[0]?.count ?? 0) >= GLOBAL_PAGE_CHECKS_PER_MINUTE) {
          outcome = 'limited';
        } else {
          const due = await client.query<{ id: string; tenant_id: string; check_interval_minutes: number }>(
            'SELECT s.id, s.tenant_id, s.check_interval_minutes FROM marketrift.sources s '
            + "WHERE s.source_type IN ('pricing_page', 'release_notes') AND s.enabled "
            + 'AND s.monitoring_enabled AND s.next_check_at <= now() '
            + 'AND NOT EXISTS (SELECT 1 FROM marketrift.source_runs r WHERE r.tenant_id = s.tenant_id '
            + "AND r.source_id = s.id AND r.run_kind = 'web_page' AND r.status IN ('pending', 'running')) "
            + 'AND NOT EXISTS (SELECT 1 FROM marketrift.source_runs r WHERE r.tenant_id = s.tenant_id '
            + "AND r.source_id = s.id AND r.retry_after_at > now()) "
            + 'AND NOT EXISTS (SELECT 1 FROM marketrift.source_runs r WHERE r.tenant_id = s.tenant_id '
            + "AND r.source_id = s.id AND r.run_kind = 'web_page' "
            + "AND r.finished_at > now() - interval '1 minute') "
            + (testTenant ? 'AND s.tenant_id = $1 ' : '')
            + 'ORDER BY s.next_check_at, s.id LIMIT 1 FOR UPDATE OF s SKIP LOCKED', scope);
          if (due.rows[0]) {
            const source = due.rows[0];
            const inserted = await client.query<Pending>(
              "INSERT INTO marketrift.source_runs (tenant_id, source_id, status, run_kind, trigger_kind) "
              + "VALUES ($1, $2, 'pending', 'web_page', 'scheduled') RETURNING id, tenant_id, source_id",
              [source.tenant_id, source.id]);
            await client.query(
              "UPDATE marketrift.sources SET next_check_at = now() + check_interval_minutes * interval '1 minute' "
              + 'WHERE tenant_id = $1 AND id = $2', [source.tenant_id, source.id]);
            pending = inserted.rows[0]; outcome = 'scheduled';
          }
        }
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally { client.release(); }

    // Failed publish leaves the same pending run for the recovery path. The job key
    // is derived from run ID, so retries and multiple dispatchers cannot create work twice.
    if (pending) {
      try { await this.jobs.publishWebPage(makeWebPageJob(pending.tenant_id, pending.source_id, pending.id)); }
      catch { return 'recovered'; }
    }
    return outcome;
  }

  private async expireOneStaleRun(client: PoolClient, testTenant?: string): Promise<void> {
    const stale = await client.query<Pending>(
      "UPDATE marketrift.source_runs SET status = 'failed', error_code = 'worker_timeout', finished_at = now() "
      + 'WHERE id = (SELECT id FROM marketrift.source_runs '
      + "WHERE run_kind = 'web_page' AND status = 'running' "
      + "AND started_at < now() - interval '10 minutes' "
      + (testTenant ? 'AND tenant_id = $1 ' : '')
      + 'ORDER BY started_at LIMIT 1 FOR UPDATE SKIP LOCKED) '
      + 'RETURNING id, tenant_id, source_id', testTenant ? [testTenant] : []);
    if (stale.rows[0]) {
      await client.query(
        "UPDATE marketrift.sources SET consecutive_failures = consecutive_failures + 1, "
        + "next_check_at = now() + interval '5 minutes' "
        + 'WHERE tenant_id = $1 AND id = $2 AND monitoring_enabled',
        [stale.rows[0].tenant_id, stale.rows[0].source_id]);
    }
  }
}
