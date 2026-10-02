import { BadRequestException, Body, ConflictException, Controller, Get, HttpCode, Inject,
  NotFoundException, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import type { QueryResultRow } from 'pg';
import { z } from 'zod';
import { Accounts } from './accounts';
import { Db } from './db';
import { Jobs } from './queue';
import { makeDiscoveryJob } from './source-discovery-job';
import { publicPageUrl } from './web-page-url';
import { canonicalGitHubRepository } from './github-source';

const uuid = z.uuid();
const profileInput = z.object({ product_id: uuid, official_domain: z.string().trim().min(4).max(253),
  aliases: z.array(z.string().trim().min(1).max(100)).max(10).default([]),
  country_code: z.string().regex(/^[A-Za-z]{2}$/).nullable().default(null),
  languages: z.array(z.string().regex(/^[a-z]{2,3}(?:-[A-Za-z]{2})?$/)).max(5).default([]),
  official_urls: z.array(z.string().max(2048)).max(10).default([]) }).strict();
const decisionInput = z.object({ decision: z.enum(['confirmed', 'rejected']) }).strict();
const runInput = z.object({ include_external_search: z.boolean().default(false) }).strict();
type Profile = QueryResultRow & { product_id: string; official_domain: string; identity_version: number;
  discovery_paused: boolean; aliases: string[]; country_code: string | null; languages: string[]; official_urls: string[] };
type Run = QueryResultRow & { id: string; product_id: string; identity_version: number;
  status: string; error_code: string | null; partial: boolean; include_external_search: boolean;
  external_search_status: string; external_queries: number; resource_failures: {
    resource: string | null; url?: string | null; code: string; limit_kind: string }[] };
type Candidate = QueryResultRow & { id: string; product_id: string; canonical_url: string;
  suggested_type: string; confidence: string; status: string; identity_version: number;
  existing_source_id: string | null; classification_version: number };

export function monitorablePageCandidate(type: string, url: string): boolean {
  const path = new URL(url).pathname.toLowerCase().replace(/\/$/, '');
  if (type === 'pricing_page') return /(?:^|\/)\b(?:pricing|prices|plans?|precos)$/.test(path);
  if (type === 'release_notes') return /(?:^|\/)\b(?:changelog|release-notes|releases)$/.test(path);
  return false;
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new BadRequestException(result.error.issues.map(issue => issue.message));
  return result.data;
}
export function officialDomain(value: string): string {
  const url = publicPageUrl(value.includes('://') ? value : `https://${value}`);
  const parsed = new URL(url);
  if (parsed.pathname !== '/' || parsed.hostname.includes('..'))
    throw new BadRequestException('Use only the official HTTPS domain, without a path');
  return parsed.hostname.toLowerCase();
}

@Controller('v1/source-discovery')
export class SourceDiscoveryController {
  constructor(@Inject(Db) private readonly db: Db, @Inject(Jobs) private readonly jobs: Jobs,
    @Inject(Accounts) private readonly accounts: Accounts) {}

  @Get()
  async list(@Req() request: Request): Promise<{ profiles: Profile[]; runs: Run[];
    candidates: Candidate[]; search_provider: 'brave_optional' }> {
    const principal = await this.accounts.principal(request);
    return this.db.tenant(principal.tenantId, async client => ({
      profiles: await this.db.rows<Profile>(client,
        'SELECT p.*, pr.name AS product_name FROM marketrift.competitor_profiles p '
        + 'JOIN marketrift.products pr ON pr.tenant_id=p.tenant_id AND pr.id=p.product_id ORDER BY pr.name'),
      runs: await this.db.rows<Run>(client,
        'SELECT id,product_id,identity_version,status,error_code,partial,resource_failures,'
        + 'include_external_search,external_search_status,external_queries,'
        + 'pages_examined,candidates_seen,candidates_new,'
        + 'created_at,finished_at,retry_after_at FROM marketrift.discovery_runs ORDER BY created_at DESC LIMIT 100'),
      candidates: await this.db.rows<Candidate>(client,
        'SELECT c.id,c.product_id,c.canonical_url,c.category,c.suggested_type,c.discovered_from_url,'
        + 'c.discovery_method,c.association_evidence,c.confidence,c.status,c.linked_source_id,'
        + 'c.identity_version,c.first_seen_at,c.last_examined_at,c.search_provider,c.search_query,'
        + 'c.classification_version,c.first_discovered_from_url,c.first_discovery_method,'
        + 'existing.id AS existing_source_id '
        + 'FROM marketrift.discovery_candidates c LEFT JOIN marketrift.sources existing '
        + 'ON existing.tenant_id=c.tenant_id AND existing.product_id=c.product_id '
        + "AND (existing.source_type=c.suggested_type OR (c.suggested_type='blog_or_feed' "
        + "AND existing.source_type='rss_feed')) AND existing.url=c.canonical_url "
        + 'ORDER BY c.last_examined_at DESC LIMIT 500'),
      search_provider: 'brave_optional' as const,
    }));
  }

  @Post('profiles')
  @HttpCode(200)
  async saveProfile(@Req() request: Request, @Body() body: unknown): Promise<Profile> {
    const principal = await this.accounts.principal(request, ['owner', 'admin']);
    const data = parse(profileInput, body);
    const domain = officialDomain(data.official_domain);
    const urls = [...new Set(data.official_urls.map(publicPageUrl))];
    const aliases = [...new Set(data.aliases.map(item => item.trim()).filter(Boolean))];
    return this.db.tenant(principal.tenantId, async client => {
      const product = await this.db.rows<{ id: string }>(client,
        "SELECT id FROM marketrift.products WHERE tenant_id=$1 AND id=$2 AND kind='competitor' FOR UPDATE",
        [principal.tenantId, data.product_id]);
      if (!product[0]) throw new NotFoundException('Competitor not found in active company');
      const rows = await this.db.rows<Profile>(client,
        'INSERT INTO marketrift.competitor_profiles (tenant_id,product_id,official_domain,aliases,country_code,languages,official_urls) '
        + 'VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (tenant_id,product_id) DO UPDATE SET '
        + 'official_domain=excluded.official_domain,aliases=excluded.aliases,country_code=excluded.country_code,'
        + 'languages=excluded.languages,official_urls=excluded.official_urls,'
        + 'identity_version=competitor_profiles.identity_version + '
        + 'CASE WHEN competitor_profiles.official_domain IS DISTINCT FROM excluded.official_domain THEN 1 ELSE 0 END,'
        + 'discovery_paused=competitor_profiles.discovery_paused,updated_at=now() RETURNING *',
        [principal.tenantId, data.product_id, domain, aliases, data.country_code?.toUpperCase() ?? null,
          data.languages, urls]);
      return rows[0]!;
    });
  }

  @Post('profiles/:productId/pause')
  @HttpCode(200)
  async pause(@Req() request: Request, @Param('productId') value: string): Promise<Profile> {
    const principal = await this.accounts.principal(request, ['owner', 'admin']);
    const productId = parse(uuid, value);
    return this.db.tenant(principal.tenantId, async client => {
      const rows = await this.db.rows<Profile>(client,
        'UPDATE marketrift.competitor_profiles SET discovery_paused=true,updated_at=now() '
        + 'WHERE tenant_id=$1 AND product_id=$2 RETURNING *', [principal.tenantId, productId]);
      if (!rows[0]) throw new NotFoundException('Competitor profile not found');
      await client.query("UPDATE marketrift.discovery_runs SET status='failed',error_code='discovery_paused',"
        + "finished_at=now() WHERE tenant_id=$1 AND product_id=$2 AND status='pending'",
      [principal.tenantId, productId]);
      return rows[0];
    });
  }

  @Post('profiles/:productId/resume')
  @HttpCode(200)
  async resume(@Req() request: Request, @Param('productId') value: string): Promise<Profile> {
    const principal = await this.accounts.principal(request, ['owner', 'admin']);
    const productId = parse(uuid, value);
    const rows = await this.db.tenant(principal.tenantId, client => this.db.rows<Profile>(client,
      'UPDATE marketrift.competitor_profiles SET discovery_paused=false,updated_at=now() '
      + 'WHERE tenant_id=$1 AND product_id=$2 RETURNING *', [principal.tenantId, productId]));
    if (!rows[0]) throw new NotFoundException('Competitor profile not found');
    return rows[0];
  }

  @Post('profiles/:productId/run')
  @HttpCode(200)
  async run(@Req() request: Request, @Param('productId') value: string, @Body() body: unknown): Promise<Run> {
    const principal = await this.accounts.principal(request, ['owner', 'admin', 'analyst']);
    const productId = parse(uuid, value);
    const { include_external_search: includeExternalSearch } = parse(runInput, body ?? {});
    const run = await this.db.tenant(principal.tenantId, async client => {
      const profiles = await this.db.rows<Profile>(client,
        'SELECT p.* FROM marketrift.competitor_profiles p JOIN marketrift.products pr '
        + "ON pr.tenant_id=p.tenant_id AND pr.id=p.product_id AND pr.kind='competitor' "
        + 'WHERE p.tenant_id=$1 AND p.product_id=$2 FOR UPDATE OF p', [principal.tenantId, productId]);
      const profile = profiles[0];
      if (!profile) throw new NotFoundException('Competitor profile not found');
      if (profile.discovery_paused) throw new ConflictException({ code: 'discovery_paused',
        message: 'A descoberta está pausada para este concorrente.' });
      await client.query("UPDATE marketrift.discovery_runs SET status='failed',error_code='worker_timeout',"
        + "finished_at=now() WHERE tenant_id=$1 AND product_id=$2 AND status IN ('pending','running') "
        + "AND created_at<now()-interval '10 minutes'", [principal.tenantId, productId]);
      const active = await this.db.rows<Run>(client,
        "SELECT id,product_id,identity_version,status,include_external_search FROM marketrift.discovery_runs WHERE tenant_id=$1 "
        + "AND product_id=$2 AND status IN ('pending','running')", [principal.tenantId, productId]);
      if (active[0]?.status === 'running') throw new ConflictException({ code: 'run_active',
        message: 'Já existe uma descoberta em execução para este concorrente.', run_id: active[0].id });
      if (active[0]) {
        if (active[0].include_external_search !== includeExternalSearch)
          throw new ConflictException({ code: 'run_active',
            message: 'Já existe uma descoberta pendente com outro modo de busca.' });
        return active[0]; // A pending row can be republished after a queue outage.
      }
      const blocked = await this.db.rows<{ retry_after_at: Date; external_search_status: string }>(client,
        'SELECT retry_after_at,external_search_status FROM marketrift.discovery_runs WHERE tenant_id=$1 AND product_id=$2 '
        + 'AND retry_after_at>now() ORDER BY retry_after_at DESC LIMIT 1',
        [principal.tenantId, productId]);
      if (blocked[0]) throw new ConflictException({
        code: blocked[0].external_search_status === 'rate_limited' ? 'search_rate_limit' : 'origin_rate_limit',
        message: blocked[0].external_search_status === 'rate_limited'
          ? 'A API de busca externa limitou as consultas.' : 'A origem limitou as requisições.',
        retry_after_at: blocked[0].retry_after_at.toISOString() });
      const recent = await this.db.rows<{ retry_at: Date }>(client,
        "SELECT finished_at + interval '5 minutes' AS retry_at FROM marketrift.discovery_runs "
        + "WHERE tenant_id=$1 AND product_id=$2 AND finished_at>now()-interval '5 minutes' "
        + "ORDER BY finished_at DESC LIMIT 1",
        [principal.tenantId, productId]);
      if (recent[0]) throw new ConflictException({ code: 'minimum_interval',
        message: 'Aguarde cinco minutos entre descobertas.', retry_after_at: recent[0].retry_at.toISOString() });
      return (await this.db.rows<Run>(client,
        'INSERT INTO marketrift.discovery_runs (tenant_id,product_id,identity_version,include_external_search) '
        + 'VALUES ($1,$2,$3,$4) RETURNING id,product_id,identity_version,status,include_external_search',
        [principal.tenantId, productId, profile.identity_version, includeExternalSearch]))[0]!;
    });
    if (run.status === 'pending') {
      try { await this.jobs.publishDiscovery(makeDiscoveryJob(principal.tenantId, productId,
        run.id, run.identity_version)); }
      catch { /* The pending run can be republished by the same manual action. */ }
    }
    return run;
  }

  @Post('candidates/:id/decision')
  @HttpCode(200)
  async decide(@Req() request: Request, @Param('id') value: string, @Body() body: unknown): Promise<Candidate> {
    const principal = await this.accounts.principal(request, ['owner', 'admin']);
    const id = parse(uuid, value);
    const { decision } = parse(decisionInput, body);
    return this.db.tenant(principal.tenantId, async client => {
      const rows = await this.db.rows<Candidate>(client,
        'SELECT c.* FROM marketrift.discovery_candidates c WHERE c.tenant_id=$1 AND c.id=$2 FOR UPDATE',
        [principal.tenantId, id]);
      const candidate = rows[0];
      if (!candidate) throw new NotFoundException('Candidate not found');
      const profile = await this.db.rows<Profile>(client,
        'SELECT * FROM marketrift.competitor_profiles WHERE tenant_id=$1 AND product_id=$2',
        [principal.tenantId, candidate.product_id]);
      if (!profile[0] || candidate.identity_version !== profile[0].identity_version)
        throw new ConflictException('Competitor domain changed; review the association before confirming');
      if (candidate.status === decision || (decision === 'confirmed' &&
        ['rights_pending', 'access_unavailable'].includes(candidate.status))) return candidate;
      if (decision === 'confirmed' && ['pricing_page', 'release_notes'].includes(candidate.suggested_type)
          && !monitorablePageCandidate(candidate.suggested_type, candidate.canonical_url))
        throw new ConflictException({ code: 'candidate_not_monitorable',
          message: 'Esta URL não é um índice de preços ou changelog monitorável. Atualize a classificação antes de confirmar.' });
      let sourceId: string | null = null;
      let recordedDecision: string = decision;
      if (decision === 'confirmed' && ['pricing_page', 'release_notes'].includes(candidate.suggested_type)
          && candidate.confidence === 'official_host' && candidate.discovery_method !== 'web_search') {
        const sourceUrl = publicPageUrl(candidate.canonical_url);
        if (new URL(sourceUrl).hostname !== profile[0].official_domain)
          throw new ConflictException('Candidate is no longer on the confirmed official domain');
        const source = await this.db.rows<{ id: string }>(client,
          "INSERT INTO marketrift.sources (tenant_id,product_id,source_type,url,check_interval_minutes,monitoring_enabled,next_check_at) "
          + "VALUES ($1,$2,$3,$4,1440,false,NULL) ON CONFLICT (tenant_id,product_id,source_type,url) "
          + "DO UPDATE SET url=excluded.url RETURNING id",
          [principal.tenantId, candidate.product_id, candidate.suggested_type, sourceUrl]);
        sourceId = source[0]!.id;
      }
      if (decision === 'confirmed' && candidate.suggested_type === 'github_repository'
          && candidate.discovery_method !== 'web_search') {
        const repository = canonicalGitHubRepository(candidate.canonical_url);
        const source = await this.db.rows<{ id: string }>(client,
          "INSERT INTO marketrift.sources (tenant_id,product_id,source_type,url) "
          + "VALUES ($1,$2,'github_issues',$3) ON CONFLICT (tenant_id,product_id,source_type,url) "
          + 'DO UPDATE SET url=excluded.url RETURNING id',
          [principal.tenantId, candidate.product_id, repository]);
        sourceId = source[0]!.id;
      }
      if (decision === 'confirmed' && !sourceId) recordedDecision =
        ['g2', 'reclameaqui'].includes(candidate.suggested_type) ? 'rights_pending'
          : candidate.discovery_method === 'web_search'
            && ['pricing_page', 'release_notes', 'github_repository'].includes(candidate.suggested_type)
            ? 'confirmed' : 'access_unavailable';
      const updated = await this.db.rows<Candidate>(client,
        'UPDATE marketrift.discovery_candidates SET status=$3,linked_source_id=$4,reviewed_by=$5,reviewed_at=now() '
        + 'WHERE tenant_id=$1 AND id=$2 RETURNING *',
        [principal.tenantId, id, recordedDecision, sourceId, principal.userId]);
      return updated[0]!;
    });
  }
}
