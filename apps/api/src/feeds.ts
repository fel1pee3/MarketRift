import { BadRequestException, Body, ConflictException, Controller, Get, HttpCode, Inject,
  NotFoundException, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import type { QueryResultRow } from 'pg';
import { z } from 'zod';
import { Accounts } from './accounts';
import { Db } from './db';
import { Jobs } from './queue';
import { makeFeedJob } from './feed-job';
import { publicPageUrl } from './web-page-url';

const uuid = z.uuid();
const createInput = z.object({ product_id: uuid, url: z.string().max(2048),
  candidate_id: uuid.optional(), association_confirmed: z.literal(true) }).strict();
const monitorInput = z.object({ enabled: z.boolean(),
  interval_minutes: z.union([z.literal(360), z.literal(1440), z.literal(10080)]) }).strict();
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new BadRequestException(result.error.issues.map(issue => issue.message));
  return result.data;
}
type FeedSource = QueryResultRow & { id: string; product_id: string; url: string;
  monitoring_enabled: boolean; check_interval_minutes: number | null; next_check_at: Date | null;
  feed_monitor_generation: number; last_checked_at: Date | null; product_name: string;
  last_status: string | null; last_error: string | null; last_attempt_at: Date | null;
  last_success_at: Date | null; scan_complete: boolean | null; retry_after_at: Date | null;
  active: boolean; entries_count: number };
type FeedRun = QueryResultRow & { id: string; source_id: string; status: string; trigger_kind: string;
  documents_seen: number; documents_new: number; documents_updated: number;
  scan_complete: boolean | null; error_code: string | null; retry_after_at: Date | null;
  started_at: Date; finished_at: Date | null; feed_monitor_generation: number | null };
type FeedEntry = QueryResultRow & { id: string; source_id: string; canonical_url: string; title: string;
  date_literal: string | null; published_at: Date | null; first_seen_at: Date; version_no: number };

@Controller('v1/feeds')
export class FeedsController {
  constructor(@Inject(Db) private readonly db: Db, @Inject(Jobs) private readonly jobs: Jobs,
    @Inject(Accounts) private readonly accounts: Accounts) {}

  @Get()
  async list(@Req() request: Request): Promise<{ sources: FeedSource[]; runs: FeedRun[]; entries: FeedEntry[] }> {
    const principal = await this.accounts.principal(request);
    return this.db.tenant(principal.tenantId, async client => ({
      sources: await this.db.rows<FeedSource>(client, `SELECT s.id,s.product_id,p.name AS product_name,
        s.url,s.monitoring_enabled,s.check_interval_minutes,s.next_check_at,
        s.feed_monitor_generation,s.last_checked_at,r.status AS last_status,
        r.error_code AS last_error,r.started_at AS last_attempt_at,r.retry_after_at,
        success.finished_at AS last_success_at,success.scan_complete,
        EXISTS (SELECT 1 FROM marketrift.source_runs active WHERE active.tenant_id=s.tenant_id
          AND active.source_id=s.id AND active.run_kind='feed' AND active.status IN ('pending','running')) AS active,
        (SELECT count(*)::integer FROM marketrift.feed_entries e
          WHERE e.tenant_id=s.tenant_id AND e.source_id=s.id) AS entries_count
        FROM marketrift.sources s JOIN marketrift.products p ON p.tenant_id=s.tenant_id AND p.id=s.product_id
        LEFT JOIN LATERAL (SELECT status,error_code,started_at,retry_after_at FROM marketrift.source_runs
          WHERE tenant_id=s.tenant_id AND source_id=s.id AND run_kind='feed'
          ORDER BY started_at DESC,id DESC LIMIT 1) r ON true
        LEFT JOIN LATERAL (SELECT finished_at,scan_complete FROM marketrift.source_runs
          WHERE tenant_id=s.tenant_id AND source_id=s.id AND run_kind='feed' AND status='succeeded'
          ORDER BY finished_at DESC,id DESC LIMIT 1) success ON true
        WHERE s.source_type='rss_feed' ORDER BY p.name,s.url`),
      runs: await this.db.rows<FeedRun>(client, `SELECT r.id,r.source_id,r.status,r.trigger_kind,
        r.documents_seen,r.documents_new,r.documents_updated,r.scan_complete,r.error_code,
        r.retry_after_at,r.started_at,r.finished_at,r.feed_monitor_generation
        FROM marketrift.source_runs r JOIN marketrift.sources s ON s.tenant_id=r.tenant_id AND s.id=r.source_id
        WHERE s.source_type='rss_feed' AND r.run_kind='feed'
        ORDER BY r.started_at DESC LIMIT 50`),
      entries: await this.db.rows<FeedEntry>(client, `SELECT e.id,e.source_id,e.canonical_url,e.title,
        e.date_literal,e.published_at,e.first_seen_at,e.version_no FROM marketrift.feed_entries e
        JOIN marketrift.sources s ON s.tenant_id=e.tenant_id AND s.id=e.source_id
        WHERE s.source_type='rss_feed' ORDER BY e.first_seen_at DESC,e.id LIMIT 50`),
    }));
  }

  @Post()
  @HttpCode(200)
  async create(@Req() request: Request, @Body() body: unknown): Promise<{ id: string; monitoring_enabled: boolean }> {
    const principal = await this.accounts.principal(request, ['owner', 'admin']);
    const data = parse(createInput, body);
    const url = publicPageUrl(data.url);
    return this.db.tenant(principal.tenantId, async client => {
      const product = await this.db.rows<{ id: string }>(client,
        "SELECT id FROM marketrift.products WHERE id=$1 AND kind='competitor' FOR UPDATE",
        [data.product_id]);
      if (!product[0]) throw new NotFoundException('Concorrente não encontrado nesta empresa');
      if (data.candidate_id) {
        const candidate = await this.db.rows<{ id: string; status: string; canonical_url: string;
          suggested_type: string; identity_version: number }>(client,
          "SELECT id,status,canonical_url,suggested_type,identity_version FROM marketrift.discovery_candidates "
          + "WHERE id=$1 AND product_id=$2 FOR UPDATE", [data.candidate_id,data.product_id]);
        if (!candidate[0] || candidate[0].status === 'rejected' ||
            candidate[0].canonical_url !== url || candidate[0].suggested_type !== 'blog_or_feed')
          throw new ConflictException('Candidata incompatível; confira URL e associação');
        const profile = await this.db.rows<{ identity_version: number }>(client,
          'SELECT identity_version FROM marketrift.competitor_profiles WHERE product_id=$1',
          [data.product_id]);
        if (!profile[0] || profile[0].identity_version !== candidate[0].identity_version)
          throw new ConflictException('Identidade do concorrente mudou; revise a candidata');
      }
      const rows = await this.db.rows<{ id: string; monitoring_enabled: boolean }>(client,
        "INSERT INTO marketrift.sources (tenant_id,product_id,source_type,url,monitoring_enabled) "
        + "VALUES ($1,$2,'rss_feed',$3,false) ON CONFLICT (tenant_id,product_id,source_type,url) "
        + "DO UPDATE SET url=excluded.url RETURNING id,monitoring_enabled",
        [principal.tenantId,data.product_id,url]);
      if (data.candidate_id) await client.query(`UPDATE marketrift.discovery_candidates
        SET status='confirmed',linked_source_id=$2,reviewed_by=$3,reviewed_at=now()
        WHERE id=$1 AND status <> 'rejected'`, [data.candidate_id,rows[0]!.id,principal.userId]);
      return { id: rows[0]!.id, monitoring_enabled: rows[0]!.monitoring_enabled };
    });
  }

  @Post(':id/monitor')
  @HttpCode(200)
  async monitor(@Req() request: Request, @Param('id') value: string, @Body() body: unknown) {
    const principal = await this.accounts.principal(request, ['owner', 'admin']);
    const id = parse(uuid,value);
    const data = parse(monitorInput,body);
    return this.db.tenant(principal.tenantId, async client => {
      const rows = await this.db.rows<FeedSource>(client,
        "SELECT * FROM marketrift.sources WHERE id=$1 AND source_type='rss_feed' FOR UPDATE", [id]);
      const source = rows[0];
      if (!source) throw new NotFoundException('Feed não encontrado');
      if (!source.enabled) throw new ConflictException('Fonte desativada');
      const changed = source.monitoring_enabled !== data.enabled ||
        source.check_interval_minutes !== data.interval_minutes;
      if (changed)
        await client.query(`UPDATE marketrift.sources SET monitoring_enabled=$2,check_interval_minutes=$3,
          next_check_at=CASE WHEN $2::boolean THEN now()+$3::integer*interval '1 minute' ELSE NULL END
          WHERE id=$1`, [id,data.enabled,data.interval_minutes]);
      if (changed || !data.enabled) await client.query(`UPDATE marketrift.source_runs SET status='cancelled',
        error_code=$2,finished_at=now() WHERE source_id=$1 AND run_kind='feed'
        AND status IN ('pending','running')`,[id,data.enabled ? 'monitoring_changed' : 'monitoring_paused']);
      return { source_id:id, monitoring_enabled:data.enabled, interval_minutes:data.interval_minutes };
    });
  }

  @Post(':id/run')
  @HttpCode(200)
  async run(@Req() request: Request, @Param('id') value: string): Promise<FeedRun> {
    const principal = await this.accounts.principal(request, ['owner','admin','analyst']);
    const id = parse(uuid,value);
    const result = await this.db.tenant(principal.tenantId, async client => {
      const sources = await this.db.rows<FeedSource>(client,
        "SELECT s.* FROM marketrift.sources s JOIN marketrift.products p "
        + "ON p.tenant_id=s.tenant_id AND p.id=s.product_id "
        + "WHERE s.id=$1 AND s.source_type='rss_feed' FOR UPDATE OF s",[id]);
      if (!sources[0] || !sources[0].enabled || !sources[0].monitoring_enabled)
        throw new ConflictException({ code:'monitoring_paused',
          message:'Ative este feed antes de verificar.' });
      await client.query(`UPDATE marketrift.source_runs SET status='failed',error_code='worker_timeout',
        finished_at=now() WHERE source_id=$1 AND run_kind='feed' AND status IN ('pending','running')
        AND started_at<now()-interval '10 minutes'`,[id]);
      const active = await this.db.rows<FeedRun>(client,
        "SELECT * FROM marketrift.source_runs WHERE source_id=$1 AND run_kind='feed' "
        + "AND status IN ('pending','running')",[id]);
      if (active[0]?.status === 'running') throw new ConflictException({ code:'run_active',
        message:'Uma verificação já está em andamento; aguarde a conclusão.', run_id:active[0].id });
      if (active[0]) return { run:active[0], created:false };
      const recent = await this.db.rows<{ retry_at: Date }>(client,
        `SELECT greatest(started_at+interval '5 minutes',
          coalesce(retry_after_at,started_at)) AS retry_at
         FROM marketrift.source_runs WHERE source_id=$1 AND run_kind='feed'
           AND status <> 'cancelled'
           AND NOT (status='failed' AND error_code IN
             ('monitoring_paused','monitoring_changed','source_changed','run_state_changed','worker_unavailable'))
           AND (started_at>now()-interval '5 minutes' OR retry_after_at>now())
         ORDER BY greatest(started_at+interval '5 minutes',
           coalesce(retry_after_at,started_at)) DESC LIMIT 1`,[id]);
      if (recent[0]) throw new ConflictException({ code:'minimum_interval',
        message:'Aguarde o intervalo mínimo ou Retry-After da origem.', retry_after_at:recent[0].retry_at });
      const originBusy = await this.db.rows<{ id: string; status: string; retry_at: Date }>(client,
        `SELECT r.id,r.status,greatest(r.started_at+interval '5 minutes',
          coalesce(r.retry_after_at,r.started_at)) AS retry_at FROM marketrift.sources other
        JOIN marketrift.source_runs r ON r.tenant_id=other.tenant_id AND r.source_id=other.id
        WHERE other.source_type='rss_feed' AND other.id<>$1 AND r.run_kind='feed'
          AND r.status<>'cancelled'
          AND NOT (r.status='failed' AND r.error_code IN
            ('monitoring_paused','monitoring_changed','source_changed','run_state_changed','worker_unavailable'))
          AND split_part(other.url,'/',3)=split_part($2::text,'/',3)
          AND (r.status IN ('pending','running') OR r.started_at>now()-interval '5 minutes'
            OR r.retry_after_at>now()) LIMIT 1`,[id,sources[0].url]);
      if (originBusy[0]) throw new ConflictException({ code:'origin_busy',
        message:originBusy[0].status === 'pending' || originBusy[0].status === 'running'
          ? 'Outro feed desta origem está em execução; aguarde a conclusão.'
          : 'Outro feed desta origem está no intervalo mínimo.',
        retry_after_at:['pending','running'].includes(originBusy[0].status)
          ? null : originBusy[0].retry_at });
      const created = (await this.db.rows<FeedRun>(client,
        `INSERT INTO marketrift.source_runs
          (tenant_id,source_id,status,run_kind,trigger_kind,feed_monitor_generation)
         VALUES ($1,$2,'pending','feed','manual',$3) RETURNING *`,
        [principal.tenantId,id,sources[0].feed_monitor_generation]))[0]!;
      return { run:created, created:true };
    });
    if (result.created) {
      try { await this.jobs.publishFeed(makeFeedJob(principal.tenantId,id,result.run.id,
        result.run.feed_monitor_generation ?? undefined)); }
      catch { /* Durable pending row is republished by the scheduler. */ }
    }
    return result.run;
  }
}
