import type { QueryResultRow } from 'pg';
import { Db } from './db';
import { Jobs } from './queue';
import { makeFeedJob } from './feed-job';

type Run = QueryResultRow & { id: string; tenant_id: string; source_id: string;
  trigger_kind: 'manual' | 'scheduled'; feed_monitor_generation: number | null };

/** The existing scheduler process claims one durable feed run per tick. */
export class FeedScheduler {
  constructor(private readonly db: Db, private readonly jobs: Jobs) {}

  async tick(): Promise<'idle' | 'locked' | 'scheduled' | 'recovered' | 'publish_failed'> {
    const testTenant = process.env.MARKETRIFT_TEST_MODE === '1'
      ? process.env.PAGE_SCHEDULER_TEST_TENANT_ID : undefined;
    if (process.env.MARKETRIFT_TEST_MODE === '1' && !testTenant) return 'idle';
    const args = testTenant ? [testTenant] : [];
    const scope = testTenant ? 'AND s.tenant_id=$1' : '';
    const client = await this.db.provisioning.connect();
    let selected: Run | undefined;
    let outcome: 'idle' | 'locked' | 'scheduled' | 'recovered' = 'idle';
    try {
      await client.query('BEGIN');
      const lock = await client.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_xact_lock(7176166031::bigint) AS locked');
      if (!lock.rows[0]?.locked) { await client.query('ROLLBACK'); return 'locked'; }
      await client.query(`UPDATE marketrift.source_runs r SET status='cancelled',
        error_code=CASE WHEN NOT s.enabled OR NOT s.monitoring_enabled
          THEN 'monitoring_paused' ELSE 'monitoring_changed' END,finished_at=now()
        FROM marketrift.sources s
        WHERE r.tenant_id=s.tenant_id AND r.source_id=s.id AND s.source_type='rss_feed'
          AND r.run_kind='feed' AND r.status IN ('pending','running')
          AND (NOT s.enabled OR NOT s.monitoring_enabled OR
               r.feed_monitor_generation IS DISTINCT FROM s.feed_monitor_generation)
          ${scope}`,args);
      await client.query(`UPDATE marketrift.source_runs r SET status='failed',
        error_code='worker_timeout',finished_at=now() FROM marketrift.sources s
        WHERE r.tenant_id=s.tenant_id AND r.source_id=s.id AND s.source_type='rss_feed'
          AND r.run_kind='feed' AND r.status='running' AND r.started_at<now()-interval '10 minutes'
          ${scope}`,args);
      const pending = await client.query<Run>(`SELECT r.id,r.tenant_id,r.source_id,
        r.trigger_kind,r.feed_monitor_generation FROM marketrift.source_runs r
        JOIN marketrift.sources s ON s.tenant_id=r.tenant_id AND s.id=r.source_id
        WHERE r.run_kind='feed' AND r.status='pending' AND r.started_at<now()-interval '15 seconds'
          AND s.source_type='rss_feed' AND s.enabled AND s.monitoring_enabled ${scope}
        ORDER BY r.started_at,r.id LIMIT 1 FOR UPDATE OF r SKIP LOCKED`,args);
      if (pending.rows[0]) { selected = pending.rows[0]; outcome='recovered'; }
      else {
        const due = await client.query<{ id: string; tenant_id: string; feed_monitor_generation: number }>(`
          SELECT s.id,s.tenant_id,s.feed_monitor_generation FROM marketrift.sources s
          WHERE s.source_type='rss_feed' AND s.enabled AND s.monitoring_enabled
            AND s.next_check_at<=now() ${scope}
            AND NOT EXISTS (SELECT 1 FROM marketrift.source_runs r
              WHERE r.tenant_id=s.tenant_id AND r.source_id=s.id AND r.run_kind='feed'
              AND r.status IN ('pending','running'))
            AND NOT EXISTS (SELECT 1 FROM marketrift.source_runs r
              WHERE r.tenant_id=s.tenant_id AND r.source_id=s.id AND r.run_kind='feed'
              AND r.status<>'cancelled' AND r.retry_after_at>now())
            AND NOT EXISTS (SELECT 1 FROM marketrift.sources other
              JOIN marketrift.source_runs r ON r.tenant_id=other.tenant_id AND r.source_id=other.id
              WHERE other.source_type='rss_feed' AND split_part(split_part(other.url,'/',3),':',1)=
                split_part(split_part(s.url,'/',3),':',1) AND r.run_kind='feed'
                AND r.status<>'cancelled'
                AND NOT (r.status='failed' AND r.error_code IN
                  ('monitoring_paused','monitoring_changed','source_changed','run_state_changed','worker_unavailable'))
                AND (r.status IN ('pending','running') OR r.started_at>now()-interval '5 minutes'))
          ORDER BY s.next_check_at,s.id LIMIT 1 FOR UPDATE OF s SKIP LOCKED`,args);
        if (due.rows[0]) {
          const source = due.rows[0];
          const rows = await client.query<Run>(`INSERT INTO marketrift.source_runs
            (tenant_id,source_id,status,run_kind,trigger_kind,feed_monitor_generation)
            VALUES ($1,$2,'pending','feed','scheduled',$3)
            RETURNING id,tenant_id,source_id,trigger_kind,feed_monitor_generation`,
          [source.tenant_id,source.id,source.feed_monitor_generation]);
          await client.query(`UPDATE marketrift.sources SET
            next_check_at=now()+check_interval_minutes*interval '1 minute'
            WHERE tenant_id=$1 AND id=$2`,[source.tenant_id,source.id]);
          selected=rows.rows[0]; outcome='scheduled';
        }
      }
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
    finally { client.release(); }
    if (selected) {
      try { await this.jobs.publishFeed(makeFeedJob(selected.tenant_id,selected.source_id,
        selected.id,selected.feed_monitor_generation ?? undefined)); }
      catch { return 'publish_failed'; }
    }
    return outcome;
  }
}
