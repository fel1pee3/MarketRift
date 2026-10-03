import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, HttpCode, Inject, NotFoundException, Param, Post, Req, UnprocessableEntityException } from '@nestjs/common';
import type { Request } from 'express';
import type { QueryResultRow } from 'pg';
import { z } from 'zod';
import { Accounts } from './accounts';
import { Db } from './db';
import { Jobs } from './queue';
import { makeWebPageJob } from './web-page-job';
import { currentPageRuleVersion, makePageReinterpretJob } from './page-reinterpret-job';
import { publicPageUrl } from './web-page-url';

const uuid = z.uuid();
const createInput = z.object({ product_id: uuid, url: z.string().min(1).max(2048),
  source_type: z.enum(['pricing_page', 'release_notes']),
  check_interval_minutes: z.union([z.literal(60), z.literal(360), z.literal(1440), z.literal(10080)]),
}).strict();
const individualInput = z.object({ candidate_id: uuid.optional(), feed_entry_id: uuid.optional(),
  association_confirmed: z.literal(true) }).strict().refine(value => Boolean(value.candidate_id) !== Boolean(value.feed_entry_id),
    'Escolha uma candidata descoberta OU uma entrada de feed');
type Source = QueryResultRow & { id: string; product_id: string; product_name: string; source_type: string;
  url: string; check_interval_minutes: number; last_checked_at: Date | null;
  monitoring_enabled: boolean; next_check_at: Date | null; consecutive_failures: number;
  origins?: { kind: string; suggested_url: string; from_url: string | null; title: string | null }[] };
type Run = QueryResultRow & { id: string; source_id: string; status: string; error_code: string | null;
  retry_after_at: Date | null; documents_new: number; started_at: Date; finished_at: Date | null;
  trigger_kind: 'manual' | 'scheduled'; capture_mode: 'static' | 'rendered_dom' };
type Snapshot = QueryResultRow & { id: string; source_id: string; version_no: number; final_url: string;
  content_sha256: string; normalized_text: string; extracted: object; fetched_at: Date;
  interpretation_version: number | null; interpretation_status: string; interpretation_reason: string;
  can_reinterpret: boolean; markup_observed_at: Date | null; capture_complete: boolean;
  capture_limit_kind: string | null };
type Interpretation = QueryResultRow & { id: string; snapshot_id: string; source_id: string;
  rule_version: number; status: string; interpretation_status: string | null; reason: string;
  basis: string; created_at: Date; finished_at: Date | null };
type Change = QueryResultRow & { id: string; source_id: string; previous_snapshot_id: string;
  current_snapshot_id: string; change_details: object[]; detected_at: Date };

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new BadRequestException(result.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`));
  return result.data;
}

@Controller('v1/page-sources')
export class WebPagesController {
  constructor(@Inject(Db) private readonly db: Db, @Inject(Jobs) private readonly jobs: Jobs,
    @Inject(Accounts) private readonly accounts: Accounts) {}

  @Post('individual')
  @HttpCode(200)
  async createIndividual(@Req() request: Request, @Body() body: unknown): Promise<{ id: string; monitoring_enabled: boolean }> {
    const principal = await this.accounts.principal(request, ['owner', 'admin']);
    const data = parse(individualInput, body);
    return this.db.tenant(principal.tenantId, async client => {
      const suggested = data.candidate_id ? await this.db.rows<{ product_id: string; canonical_url: string;
        discovered_from_url: string; identity_version: number; status: string;
        category: string; suggested_type: string }>(client,
        'SELECT product_id,canonical_url,discovered_from_url,identity_version,status,category,suggested_type '
        + 'FROM marketrift.discovery_candidates WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
        [principal.tenantId, data.candidate_id]) : await this.db.rows<{ product_id: string;
        canonical_url: string; discovered_from_url: string; identity_version: number; status: string;
        category?: string; suggested_type?: string }>(client,
        "SELECT s.product_id,e.canonical_url,s.url AS discovered_from_url,0 AS identity_version,'available' AS status "
        + 'FROM marketrift.feed_entries e JOIN marketrift.sources s ON s.tenant_id=e.tenant_id AND s.id=e.source_id '
        + "WHERE e.tenant_id=$1 AND e.id=$2 AND s.source_type='rss_feed' FOR UPDATE OF e",
        [principal.tenantId, data.feed_entry_id]);
      const item = suggested[0];
      if (!item || item.status === 'rejected') throw new NotFoundException('URL não disponível na empresa ativa');
      if (item.category === 'reviews' ||
        ['g2','reclameaqui','app_store','play_store'].includes(item.suggested_type ?? ''))
        throw new ConflictException('Fontes de avaliações exigem conector e direitos específicos');
      if (data.candidate_id) {
        const profiles = await this.db.rows<{ identity_version: number }>(client,
          'SELECT identity_version FROM marketrift.competitor_profiles WHERE tenant_id=$1 AND product_id=$2',
          [principal.tenantId, item.product_id]);
        if (profiles[0]?.identity_version !== item.identity_version)
          throw new ConflictException('Identidade do concorrente mudou; revise o vínculo antes de cadastrar');
      }
      const url = publicPageUrl(item.canonical_url);
      const existing = await this.db.rows<{ id: string; source_type: string }>(client,
        "SELECT id,source_type FROM marketrift.sources WHERE tenant_id=$1 AND product_id=$2 AND url=$3 "
        + "AND source_type IN ('public_page','pricing_page','release_notes') FOR UPDATE",
        [principal.tenantId, item.product_id, url]);
      if (existing.some(row => row.source_type !== 'public_page'))
        throw new ConflictException('Esta URL já está cadastrada como página de preços ou changelog');
      const rows = existing.length ? existing : await this.db.rows<{ id: string; source_type: string }>(client,
        "INSERT INTO marketrift.sources (tenant_id,product_id,source_type,url,monitoring_enabled,next_check_at,access_environment) "
        + "VALUES ($1,$2,'public_page',$3,false,NULL,$4) "
        + "ON CONFLICT (tenant_id,product_id,source_type,url) DO UPDATE SET url=EXCLUDED.url "
        + "RETURNING id,source_type",
        [principal.tenantId, item.product_id, url, process.env.MARKETRIFT_TEST_MODE === '1' ? 'sandbox' : null]);
      await client.query('INSERT INTO marketrift.public_page_origins '
        + '(tenant_id,source_id,candidate_id,feed_entry_id,suggested_url,confirmed_by) '
        + 'VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING',
      [principal.tenantId, rows[0]!.id, data.candidate_id ?? null, data.feed_entry_id ?? null,
        item.canonical_url, principal.userId]);
      return { id: rows[0]!.id, monitoring_enabled: false };
    });
  }

  @Post()
  async create(@Req() request: Request, @Body() body: unknown): Promise<Omit<Source, 'product_name'>> {
    const principal = await this.accounts.principal(request, ['owner', 'admin']);
    const data = parse(createInput, body);
    const url = publicPageUrl(data.url);
    try {
      return await this.db.tenant(principal.tenantId, async client => {
        const rows = await this.db.rows<Source>(client,
          "INSERT INTO marketrift.sources (tenant_id, product_id, source_type, url, check_interval_minutes, "
          + "monitoring_enabled, next_check_at, access_environment) SELECT $1, id, $3, $4, $5, true, now(), $6 "
          + "FROM marketrift.products WHERE tenant_id = $1 AND id = $2 "
          + "RETURNING id, product_id, source_type, url, check_interval_minutes, last_checked_at, "
          + "monitoring_enabled, next_check_at, consecutive_failures",
          [principal.tenantId, data.product_id, data.source_type, url, data.check_interval_minutes,
            process.env.MARKETRIFT_TEST_MODE === '1' ? 'sandbox' : null]);
        if (!rows[0]) throw new NotFoundException('Product not found in active company');
        return rows[0];
      });
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') {
        throw new ConflictException('Page source already exists');
      }
      throw error;
    }
  }

  @Get()
  async list(@Req() request: Request): Promise<{ sources: Source[]; runs: Run[]; snapshots: Snapshot[];
    changes: Change[]; interpretations: Interpretation[]; active_rule_version: number }> {
    const principal = await this.accounts.principal(request);
    return this.db.tenant(principal.tenantId, async client => {
      const sources = await this.db.rows<Source>(client,
        "SELECT s.id, s.product_id, p.name AS product_name, s.source_type, s.url, "
        + "s.check_interval_minutes, s.last_checked_at, s.monitoring_enabled, s.next_check_at, "
        + "s.consecutive_failures,coalesce((SELECT jsonb_agg(jsonb_build_object('kind', "
        + "CASE WHEN o.candidate_id IS NOT NULL THEN 'discovery' ELSE 'feed' END, "
        + "'suggested_url',o.suggested_url,'from_url',coalesce(c.discovered_from_url,fs.url), "
        + "'title',e.title)) FROM marketrift.public_page_origins o "
        + "LEFT JOIN marketrift.discovery_candidates c ON c.tenant_id=o.tenant_id AND c.id=o.candidate_id "
        + "LEFT JOIN marketrift.feed_entries e ON e.tenant_id=o.tenant_id AND e.id=o.feed_entry_id "
        + "LEFT JOIN marketrift.sources fs ON fs.tenant_id=e.tenant_id AND fs.id=e.source_id "
        + "WHERE o.tenant_id=s.tenant_id AND o.source_id=s.id),'[]'::jsonb) AS origins FROM marketrift.sources s "
        + "JOIN marketrift.products p ON p.tenant_id = s.tenant_id AND p.id = s.product_id "
        + "WHERE s.source_type IN ('pricing_page', 'release_notes','public_page') ORDER BY s.id");
      const runs = await this.db.rows<Run>(client,
        "SELECT r.id, r.source_id, r.status, r.error_code, r.retry_after_at, r.documents_new, r.trigger_kind, r.capture_mode, "
        + "r.started_at, r.finished_at FROM marketrift.source_runs r JOIN marketrift.sources s "
        + "ON s.tenant_id = r.tenant_id AND s.id = r.source_id "
        + "WHERE r.run_kind = 'web_page' ORDER BY r.started_at DESC LIMIT 100");
      const snapshots = await this.db.rows<Snapshot>(client,
        "SELECT ss.id, ss.source_id, ss.version_no, ss.final_url, ss.content_sha256, "
        + "ss.normalized_text, CASE WHEN ss.interpretation_version IS NULL THEN "
        + "jsonb_build_object('kind', ss.extracted->'kind', 'text', ss.extracted->'text', "
        + "'excerpt', ss.extracted->'excerpt') ELSE ss.extracted END AS extracted, "
        + "ss.fetched_at, ss.interpretation_version, ss.interpretation_status, ss.interpretation_reason, "
        + "ss.reparse_markup IS NOT NULL AS can_reinterpret, ss.markup_observed_at, "
        + "ss.capture_complete, ss.capture_limit_kind FROM marketrift.source_snapshots ss "
        + "WHERE ss.extracted IS NOT NULL ORDER BY ss.fetched_at DESC LIMIT 100");
      const changes = await this.db.rows<Change>(client,
        "SELECT c.id, c.source_id, c.previous_snapshot_id, c.current_snapshot_id, "
        + "CASE WHEN prev_ss.interpretation_status = 'needs_review' OR "
        + "next_ss.interpretation_status = 'needs_review' THEN "
        + "'[ {\"kind\":\"legacy_interpretation_requires_review\"} ]'::jsonb "
        + 'ELSE c.change_details END AS change_details, c.detected_at '
        + 'FROM marketrift.page_changes c JOIN marketrift.source_snapshots prev_ss '
        + 'ON prev_ss.tenant_id = c.tenant_id AND prev_ss.id = c.previous_snapshot_id '
        + 'JOIN marketrift.source_snapshots next_ss '
        + 'ON next_ss.tenant_id = c.tenant_id AND next_ss.id = c.current_snapshot_id '
        + 'ORDER BY c.detected_at DESC LIMIT 100');
      const interpretations = await this.db.rows<Interpretation>(client,
        'SELECT id,source_id,snapshot_id,rule_version,status,interpretation_status,reason,basis,'
        + 'created_at,finished_at FROM marketrift.snapshot_interpretations '
        + 'ORDER BY created_at DESC,id DESC LIMIT 300');
      return { sources, runs, snapshots, changes, interpretations,
        active_rule_version: currentPageRuleVersion };
    });
  }

  @Post('snapshots/:snapshotId/reinterpret')
  @HttpCode(200)
  async reinterpret(@Req() request: Request, @Param('snapshotId') value: string): Promise<Interpretation> {
    const principal = await this.accounts.principal(request, ['owner', 'admin', 'analyst']);
    const snapshotId = parse(uuid, value);
    const row = await this.db.tenant(principal.tenantId, async client => {
      const snapshots = await this.db.rows<{ id: string; source_id: string; can_reinterpret: boolean;
        markup_observed_at: Date | null; fetched_at: Date }>(client,
        "SELECT ss.id,ss.source_id,ss.reparse_markup IS NOT NULL AS can_reinterpret,"
        + "ss.markup_observed_at,ss.fetched_at FROM marketrift.source_snapshots ss "
        + "JOIN marketrift.sources s ON s.tenant_id=ss.tenant_id AND s.id=ss.source_id "
        + "WHERE ss.tenant_id=$1 AND ss.id=$2 AND ss.version_no IS NOT NULL "
        + "AND s.enabled AND s.source_type IN ('release_notes','pricing_page') FOR UPDATE OF ss",
        [principal.tenantId, snapshotId]);
      const snapshot = snapshots[0];
      if (!snapshot) throw new NotFoundException('Snapshot not found in active company');
      if (!snapshot.can_reinterpret) throw new UnprocessableEntityException({
        code: 'historical_markup_unavailable', rule_version: currentPageRuleVersion,
        message: 'Esta captura antiga guarda texto, mas não o HTML com links e datas. Faça uma nova verificação permitida; conteúdo igual não cria outra versão.' });
      const basis = snapshot.markup_observed_at && snapshot.markup_observed_at > snapshot.fetched_at ?
        'later_same_text_capture' : 'stored_markup';
      const inserted = await this.db.rows<Interpretation>(client,
        "INSERT INTO marketrift.snapshot_interpretations "
        + "(tenant_id,source_id,snapshot_id,rule_version,status,reason,basis) "
        + "VALUES ($1,$2,$3,$4,'pending','queued',$5) "
        + 'ON CONFLICT (tenant_id,snapshot_id,rule_version) DO NOTHING RETURNING *',
        [principal.tenantId, snapshot.source_id, snapshotId, currentPageRuleVersion, basis]);
      if (inserted[0]) return inserted[0];
      const existing = await this.db.rows<Interpretation>(client,
        'SELECT * FROM marketrift.snapshot_interpretations WHERE tenant_id=$1 AND snapshot_id=$2 '
        + 'AND rule_version=$3', [principal.tenantId, snapshotId, currentPageRuleVersion]);
      return existing[0]!;
    });
    if (row.status === 'pending') {
      try { await this.jobs.publishPageReinterpret(makePageReinterpretJob(principal.tenantId,
        row.source_id, snapshotId, row.id)); }
      catch { /* Pending row remains durable; the same manual action can republish it. */ }
    }
    return row;
  }

  @Post(':id/pause')
  @HttpCode(200)
  async pause(@Req() request: Request, @Param('id') value: string): Promise<{ monitoring_enabled: boolean }> {
    const principal = await this.accounts.principal(request, ['owner', 'admin']);
    const sourceId = parse(uuid, value);
    return this.db.tenant(principal.tenantId, async client => {
      const rows = await this.db.rows<{ id: string }>(client,
        "UPDATE marketrift.sources SET monitoring_enabled = false, next_check_at = NULL "
        + "WHERE tenant_id = $1 AND id = $2 AND source_type IN ('pricing_page', 'release_notes') "
        + 'RETURNING id', [principal.tenantId, sourceId]);
      if (!rows[0]) throw new NotFoundException('Page source not found in active company');
      await client.query("UPDATE marketrift.source_runs SET status = 'failed', error_code = 'monitor_paused', "
        + "finished_at = now() WHERE tenant_id = $1 AND source_id = $2 AND run_kind = 'web_page' "
        + "AND trigger_kind = 'scheduled' AND status = 'pending'", [principal.tenantId, sourceId]);
      return { monitoring_enabled: false };
    });
  }

  @Post(':id/resume')
  @HttpCode(200)
  async resume(@Req() request: Request, @Param('id') value: string): Promise<{ monitoring_enabled: boolean; next_check_at: Date }> {
    const principal = await this.accounts.principal(request, ['owner', 'admin']);
    const sourceId = parse(uuid, value);
    return this.db.tenant(principal.tenantId, async client => {
      const rows = await this.db.rows<{ next_check_at: Date }>(client,
        "UPDATE marketrift.sources s SET monitoring_enabled = true, "
        + "next_check_at = greatest(now(), coalesce((SELECT max(r.finished_at) + interval '1 minute' "
        + "FROM marketrift.source_runs r WHERE r.tenant_id = s.tenant_id AND r.source_id = s.id "
        + "AND r.run_kind = 'web_page'), now()), coalesce((SELECT max(r.retry_after_at) "
        + "FROM marketrift.source_runs r WHERE r.tenant_id = s.tenant_id AND r.source_id = s.id), now())) "
        + "WHERE s.tenant_id = $1 AND s.id = $2 AND s.source_type IN ('pricing_page', 'release_notes') "
        + 'RETURNING next_check_at', [principal.tenantId, sourceId]);
      if (!rows[0]) throw new NotFoundException('Page source not found in active company');
      return { monitoring_enabled: true, next_check_at: rows[0].next_check_at };
    });
  }

  @Post(':id/check')
  @HttpCode(200)
  async check(@Req() request: Request, @Param('id') value: string): Promise<{ id: string; status: string }> {
    return this.queueCheck(request, value, 'static');
  }

  @Post(':id/check-rendered')
  @HttpCode(200)
  async checkRendered(@Req() request: Request, @Param('id') value: string): Promise<{ id: string; status: string }> {
    return this.queueCheck(request, value, 'rendered_dom');
  }

  private async queueCheck(request: Request, value: string, captureMode: 'static' | 'rendered_dom'):
      Promise<{ id: string; status: string }> {
    const principal = await this.accounts.principal(request, ['owner', 'admin', 'analyst']);
    const sourceId = parse(uuid, value);
    const run = await this.db.tenant(principal.tenantId, async client => {
      const source = await this.db.rows<{ id: string; source_type: string }>(client,
        "SELECT id,source_type FROM marketrift.sources WHERE tenant_id = $1 AND id = $2 "
        + "AND source_type IN ('pricing_page', 'release_notes','public_page') AND enabled = true FOR UPDATE",
        [principal.tenantId, sourceId]);
      if (!source[0]) throw new NotFoundException('Page source not found in active company');
      if (source[0].source_type === 'public_page' && !['owner', 'admin'].includes(principal.role))
        throw new ForbiddenException('Somente owner/admin podem capturar página individual');
      if (captureMode === 'rendered_dom' && source[0].source_type !== 'public_page')
        throw new BadRequestException('Renderização é permitida apenas para página pública individual');
      await client.query("UPDATE marketrift.source_runs SET status = 'failed', error_code = 'worker_timeout', finished_at = now() "
        + "WHERE tenant_id = $1 AND source_id = $2 AND run_kind = 'web_page' AND status = 'running' "
        + "AND started_at < now() - interval '10 minutes'", [principal.tenantId, sourceId]);
      const active = await this.db.rows<{ id: string; status: string; capture_mode: string }>(client,
        "SELECT id, status, capture_mode FROM marketrift.source_runs WHERE tenant_id = $1 AND source_id = $2 "
        + "AND run_kind = 'web_page' AND status IN ('pending', 'running') LIMIT 1",
        [principal.tenantId, sourceId]);
      if (active[0]) {
        if (active[0].status === 'running') throw new ConflictException('Já existe uma verificação em andamento. Aguarde a conclusão.');
        if (active[0].capture_mode !== captureMode)
          throw new ConflictException('Há uma captura de outro modo pendente para esta fonte. Aguarde sua conclusão.');
        return active[0];
      }
      const blocked = await this.db.rows<{ retry_after_at: Date }>(client,
        'SELECT retry_after_at FROM marketrift.source_runs WHERE tenant_id = $1 AND source_id = $2 '
        + 'AND retry_after_at > now() ORDER BY retry_after_at DESC LIMIT 1',
        [principal.tenantId, sourceId]);
      if (blocked[0]) throw new ConflictException(`A origem pediu uma pausa. Tente novamente após ${blocked[0].retry_after_at.toISOString()}.`);
      const recent = await this.db.rows<{ finished_at: Date }>(client,
        "SELECT finished_at FROM marketrift.source_runs WHERE tenant_id = $1 AND source_id = $2 "
        + "AND run_kind = 'web_page' AND finished_at > now() - interval '1 minute' "
        + 'ORDER BY finished_at DESC LIMIT 1', [principal.tenantId, sourceId]);
      if (recent[0]) throw new ConflictException(`Aguarde o intervalo mínimo. Tente novamente após ${new Date(recent[0].finished_at.getTime() + 60_000).toISOString()}.`);
      const rows = await this.db.rows<{ id: string; status: string }>(client,
        "INSERT INTO marketrift.source_runs (tenant_id, source_id, status, run_kind, capture_mode) "
        + "VALUES ($1, $2, 'pending', 'web_page', $3) RETURNING id, status",
        [principal.tenantId, sourceId, captureMode]);
      return rows[0]!;
    });
    try { await this.jobs.publishWebPage(makeWebPageJob(principal.tenantId, sourceId, run.id)); }
    catch { /* A pending run can be published again with the same ID. */ }
    return run;
  }
}
