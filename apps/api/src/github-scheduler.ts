import type { PoolClient, QueryResultRow } from 'pg';
import { Db } from './db';
import { Jobs } from './queue';
import { makeGitHubJob } from './github-job';
import { makeGitHubDiscussionsJob } from './github-discussions-job';

type Run = QueryResultRow & { id: string; tenant_id: string; source_id: string;
  source_type: 'github_issues' | 'github_discussions'; github_monitor_generation: number };
const LIMIT_PER_MINUTE = 2;
const MAX_PAGES = 1;
const MAX_ITEMS = 5;

/** One bounded GitHub run per tick. PostgreSQL owns the schedule; Redis is only delivery. */
export class GitHubScheduler {
  constructor(private readonly db: Db, private readonly jobs: Jobs) {}

  async tick(): Promise<'idle' | 'locked' | 'limited' | 'scheduled' | 'recovered' | 'publish_failed'> {
    const testTenant = process.env.MARKETRIFT_TEST_MODE === '1'
      ? process.env.PAGE_SCHEDULER_TEST_TENANT_ID : undefined;
    if (process.env.MARKETRIFT_TEST_MODE === '1' && !testTenant) return 'idle';
    const args = testTenant ? [testTenant] : [];
    const scope = testTenant ? 'AND s.tenant_id=$1 ' : '';
    const client = await this.db.provisioning.connect();
    let selected: Run | undefined;
    let outcome: 'idle' | 'locked' | 'limited' | 'scheduled' | 'recovered' = 'idle';
    try {
      await client.query('BEGIN');
      const lock = await client.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_xact_lock(7176166028::bigint) AS locked');
      if (!lock.rows[0]?.locked) { await client.query('ROLLBACK'); return 'locked'; }

      // A paused or edited source invalidates the revision of any old scheduled run.
      await client.query(`UPDATE marketrift.source_runs r SET status='failed',
        error_code='monitoring_changed',finished_at=now() FROM marketrift.sources s
        WHERE r.tenant_id=s.tenant_id AND r.source_id=s.id AND r.run_kind='connector'
          AND r.trigger_kind='scheduled' AND r.status='pending'
          AND (NOT s.enabled OR NOT s.monitoring_enabled OR
               r.github_monitor_generation IS DISTINCT FROM s.github_monitor_generation)
          ${testTenant ? 'AND s.tenant_id=$1' : ''}`, args);
      await client.query(`UPDATE marketrift.source_runs r SET status='failed',
        error_code='worker_timeout',finished_at=now() FROM marketrift.sources s
        WHERE r.tenant_id=s.tenant_id AND r.source_id=s.id AND r.run_kind='connector'
          AND r.trigger_kind='scheduled' AND r.status='running'
          AND r.started_at<now()-interval '10 minutes'
          ${testTenant ? 'AND s.tenant_id=$1' : ''}`, args);
      const pending = await client.query<Run>(`SELECT r.id,r.tenant_id,r.source_id,
        s.source_type,r.github_monitor_generation FROM marketrift.source_runs r
        JOIN marketrift.sources s ON s.tenant_id=r.tenant_id AND s.id=r.source_id
        WHERE r.run_kind='connector' AND r.trigger_kind='scheduled' AND r.status='pending'
          AND r.started_at<now()-interval '15 seconds' AND s.enabled AND s.monitoring_enabled
          AND r.github_monitor_generation=s.github_monitor_generation ${scope}
        ORDER BY r.started_at,r.id LIMIT 1 FOR UPDATE OF r SKIP LOCKED`, args);
      if (pending.rows[0]) { selected = pending.rows[0]; outcome = 'recovered'; }
      else {
        const volume = await client.query<{ n: number }>(`SELECT count(*)::int AS n
          FROM marketrift.source_runs r JOIN marketrift.sources s
            ON s.tenant_id=r.tenant_id AND s.id=r.source_id
          WHERE s.source_type IN ('github_issues','github_discussions')
            AND r.trigger_kind='scheduled' AND r.started_at>now()-interval '1 minute'
            ${testTenant ? 'AND s.tenant_id=$1' : ''}`, args);
        if ((volume.rows[0]?.n ?? 0) >= LIMIT_PER_MINUTE) outcome = 'limited';
        else {
          const due = await client.query<Run>(`SELECT s.id AS source_id,s.tenant_id,
            s.source_type,s.github_monitor_generation FROM marketrift.sources s
            WHERE s.source_type IN ('github_issues','github_discussions')
              AND s.enabled AND s.monitoring_enabled AND s.next_check_at<=now()
              ${process.env.MARKETRIFT_TEST_MODE === '1' ? '' : "AND s.access_environment IS DISTINCT FROM 'sandbox'"} ${scope}
              AND NOT EXISTS (SELECT 1 FROM marketrift.source_runs r
                WHERE r.tenant_id=s.tenant_id AND r.source_id=s.id AND r.max_pages IS NOT NULL
                  AND r.status IN ('pending','running'))
              AND NOT EXISTS (SELECT 1 FROM marketrift.source_runs r
                WHERE r.tenant_id=s.tenant_id AND r.source_id=s.id AND r.retry_after_at>now())
              AND NOT EXISTS (SELECT 1 FROM marketrift.sources other
                JOIN marketrift.source_runs r ON r.tenant_id=other.tenant_id AND r.source_id=other.id
                WHERE other.source_type IN ('github_issues','github_discussions')
                  AND other.url=s.url AND r.max_pages IS NOT NULL
                  AND (r.status IN ('pending','running') OR r.started_at>now()-interval '5 minutes'))
            ORDER BY s.next_check_at,s.id LIMIT 1 FOR UPDATE OF s SKIP LOCKED`, args);
          const source = due.rows[0];
          if (source) {
            const previous = await client.query<{ cursor_after: string | null; scan_complete: boolean | null }>(
              `SELECT cursor_after,scan_complete FROM marketrift.source_runs
               WHERE tenant_id=$1 AND source_id=$2 AND max_pages IS NOT NULL
                 AND status='succeeded' ORDER BY finished_at DESC LIMIT 1`,
              [source.tenant_id,source.source_id]);
            const cursor = source.source_type === 'github_discussions' && previous.rows[0]?.scan_complete !== false
              ? null : previous.rows[0]?.cursor_after ?? null;
            const inserted = await client.query<Run>(`INSERT INTO marketrift.source_runs
              (tenant_id,source_id,status,run_kind,trigger_kind,cursor_before,max_pages,max_items,
               github_monitor_generation) VALUES ($1,$2,'pending','connector','scheduled',$3,$4,$5,$6)
              RETURNING id,tenant_id,source_id,github_monitor_generation`,
              [source.tenant_id,source.source_id,cursor,MAX_PAGES,MAX_ITEMS,source.github_monitor_generation]);
            await client.query(`UPDATE marketrift.sources SET
              next_check_at=now()+check_interval_minutes*interval '1 minute'
              WHERE tenant_id=$1 AND id=$2`, [source.tenant_id,source.source_id]);
            selected = { ...inserted.rows[0]!, source_type: source.source_type };
            outcome = 'scheduled';
          }
        }
      }
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
    finally { client.release(); }
    if (selected) {
      try {
        if (selected.source_type === 'github_issues')
          await this.jobs.publishGitHub(makeGitHubJob(selected.tenant_id,selected.source_id,
            selected.id,selected.github_monitor_generation));
        else await this.jobs.publishDiscussions(makeGitHubDiscussionsJob(selected.tenant_id,
          selected.source_id,selected.id,selected.github_monitor_generation));
      } catch { return 'publish_failed'; }
    }
    return outcome;
  }
}
