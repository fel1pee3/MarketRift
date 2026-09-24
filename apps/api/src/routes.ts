import { BadRequestException, ConflictException, Controller, Get, HttpCode, Inject, NotFoundException, Param, Post, Body, Req, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { randomUUID } from 'node:crypto';
import { Request } from 'express';
import { QueryResultRow } from 'pg';
import { parse } from 'csv-parse/sync';
import { z } from 'zod';
import { Db } from './db';
import { Jobs } from './queue';
import { makeJob } from './job';
import { activeExtractorVersion, makeAnalysisJob } from './analysis-job';
import { Accounts, Principal, Role } from './accounts';
import { canonicalGitHubRepository } from './github-source';
import { makeGitHubJob } from './github-job';

const uuid = z.uuid();
const httpUrl = z.url().refine(value => /^https?:\/\//i.test(value), 'HTTP(S) URL required');
const productInput = z.object({ name: z.string().trim().min(1).max(120), kind: z.enum(['own', 'competitor']), website_url: httpUrl.optional() }).strict();
const sourceInput = z.object({ product_id: uuid, url: httpUrl }).strict();
const githubSourceInput = z.object({ product_id: uuid, repository: z.string().trim().min(3).max(250) }).strict();
const githubSyncInput = z.object({ max_pages: z.number().int().min(1).max(3), max_items: z.number().int().min(1).max(50) }).strict();
const csvRow = z.object({ external_key: z.string().trim().min(1).max(200), source_url: httpUrl, published_at: z.iso.datetime({ offset: true }), body: z.string().trim().min(1).max(10000), synthetic: z.enum(['true', 'false', '']).optional() }).strict();
type ProductRow = QueryResultRow & { id: string; name: string; kind: 'own' | 'competitor'; website_url: string | null };
type SourceRow = QueryResultRow & { id: string; product_id: string; source_type: 'manual_review' | 'github_issues'; url: string; last_checked_at?: Date | null };
type SourceRunRow = QueryResultRow & { id: string; source_id: string; status: string; documents_seen: number; documents_new: number; documents_updated: number; pages_fetched: number; pull_requests_skipped: number; error_code: string | null; retry_after_at: Date | null; started_at: Date; finished_at: Date | null };
type ImportRow = QueryResultRow & { id: string; source_id: string; status: string; total_rows: number; processed_rows: number; last_error: string | null; created_at: Date; finished_at: Date | null };
type DocumentRow = QueryResultRow & { id: string; source_id: string; product_id: string; document_type: 'review' | 'github_issue'; external_key: string; source_url: string; body: string; source_title: string | null; source_body: string | null; source_state: string | null; source_repository: string | null; source_created_at: Date | null; source_updated_at: Date | null; published_at: Date | null; collected_at: Date; synthetic: boolean; analysis_status: string | null; analysis_model: string | null; analysis_error: string | null; issues: { category: string; sentiment: string; severity: string; description: string; evidence_quote: string }[] };

function input<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new BadRequestException(parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`));
  return parsed.data;
}
function conflict(error: unknown): never {
  if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') throw new ConflictException('Resource already exists');
  throw error;
}

@Controller('v1')
export class ApiController {
  constructor(@Inject(Db) private readonly db: Db, @Inject(Jobs) private readonly jobs: Jobs,
    @Inject(Accounts) private readonly accounts: Accounts) {}

  private async principal(request: Request, allowed: Role[] = ['owner', 'admin', 'analyst', 'viewer']): Promise<Principal> {
    return this.accounts.principal(request, allowed);
  }

  @Get('me')
  async me(@Req() request: Request): Promise<Principal> { return this.principal(request); }

  @Post('products')
  async createProduct(@Req() request: Request, @Body() body: unknown): Promise<ProductRow> {
    const principal = await this.principal(request, ['owner', 'admin']);
    const data = input(productInput, body);
    try { return await this.db.tenant(principal.tenantId, async client => (await this.db.rows<ProductRow>(client,
      'INSERT INTO marketrift.products (tenant_id, name, kind, website_url) VALUES ($1, $2, $3, $4) RETURNING id, name, kind, website_url',
      [principal.tenantId, data.name, data.kind, data.website_url ?? null]))[0]!); }
    catch (error) { return conflict(error); }
  }

  @Get('products')
  async products(@Req() request: Request): Promise<ProductRow[]> {
    const principal = await this.principal(request);
    return this.db.tenant(principal.tenantId, client => this.db.rows<ProductRow>(client,
      'SELECT id, name, kind, website_url FROM marketrift.products ORDER BY created_at, id'));
  }

  @Post('sources')
  async createSource(@Req() request: Request, @Body() body: unknown): Promise<SourceRow> {
    const principal = await this.principal(request, ['owner', 'admin']);
    const data = input(sourceInput, body);
    try {
      return await this.db.tenant(principal.tenantId, async client => {
        const rows = await this.db.rows<SourceRow>(client,
          "INSERT INTO marketrift.sources (tenant_id, product_id, source_type, url) SELECT $1, id, 'manual_review', $3 FROM marketrift.products WHERE id = $2 RETURNING id, product_id, source_type, url",
          [principal.tenantId, data.product_id, data.url]);
        if (!rows[0]) throw new NotFoundException('Product not found');
        return rows[0];
      });
    } catch (error) { return conflict(error); }
  }

  @Get('sources')
  async sources(@Req() request: Request): Promise<SourceRow[]> {
    const principal = await this.principal(request);
    return this.db.tenant(principal.tenantId, client => this.db.rows<SourceRow>(client,
      'SELECT id, product_id, source_type, url, last_checked_at FROM marketrift.sources ORDER BY id'));
  }

  @Post('sources/github-issues')
  async createGitHubSource(@Req() request: Request, @Body() body: unknown): Promise<SourceRow> {
    const principal = await this.principal(request, ['owner', 'admin']);
    const data = input(githubSourceInput, body);
    const url = canonicalGitHubRepository(data.repository);
    try {
      return await this.db.tenant(principal.tenantId, async client => {
        const rows = await this.db.rows<SourceRow>(client,
          "INSERT INTO marketrift.sources (tenant_id, product_id, source_type, url) SELECT $1, id, 'github_issues', $3 FROM marketrift.products WHERE id = $2 RETURNING id, product_id, source_type, url, last_checked_at",
          [principal.tenantId, data.product_id, url]);
        if (!rows[0]) throw new NotFoundException('Product not found');
        return rows[0];
      });
    } catch (error) { return conflict(error); }
  }

  @Post('sources/:id/sync')
  @HttpCode(200)
  async syncGitHubSource(@Req() request: Request, @Param('id') idValue: string, @Body() body: unknown): Promise<{ id: string; status: string }> {
    const principal = await this.principal(request, ['owner', 'admin', 'analyst']);
    const sourceId = input(uuid, idValue);
    const limits = input(githubSyncInput, body);
    const run = await this.db.tenant(principal.tenantId, async client => {
      const source = await this.db.rows<{ id: string }>(client,
        "SELECT id FROM marketrift.sources WHERE id = $1 AND source_type = 'github_issues' AND enabled = true FOR UPDATE", [sourceId]);
      if (!source[0]) throw new NotFoundException('GitHub Issues source not found');
      await client.query("UPDATE marketrift.source_runs SET status = 'failed', error_code = 'worker_timeout', finished_at = now() "
        + "WHERE source_id = $1 AND max_pages IS NOT NULL AND status = 'running' "
        + "AND started_at < now() - interval '10 minutes'", [sourceId]);
      const active = await this.db.rows<{ id: string; status: string }>(client,
        "SELECT id, status FROM marketrift.source_runs WHERE source_id = $1 AND max_pages IS NOT NULL AND status IN ('pending', 'running') ORDER BY started_at DESC LIMIT 1", [sourceId]);
      if (active[0]) {
        if (active[0].status === 'running') throw new ConflictException('Sync already running');
        return active[0];
      }
      const blocked = await this.db.rows<{ retry_after_at: Date }>(client,
        'SELECT retry_after_at FROM marketrift.source_runs WHERE source_id = $1 AND retry_after_at > now() ORDER BY retry_after_at DESC LIMIT 1', [sourceId]);
      if (blocked[0]) throw new ConflictException(`GitHub rate limit; retry after ${blocked[0].retry_after_at.toISOString()}`);
      const previous = await this.db.rows<{ cursor_after: string | null }>(client,
        "SELECT cursor_after FROM marketrift.source_runs WHERE source_id = $1 AND status = 'succeeded' AND max_pages IS NOT NULL ORDER BY finished_at DESC LIMIT 1", [sourceId]);
      const rows = await this.db.rows<{ id: string; status: string }>(client,
        "INSERT INTO marketrift.source_runs (tenant_id, source_id, status, cursor_before, max_pages, max_items) VALUES ($1, $2, 'pending', $3, $4, $5) RETURNING id, status",
        [principal.tenantId, sourceId, previous[0]?.cursor_after ?? null, limits.max_pages, limits.max_items]);
      return rows[0]!;
    });
    try { await this.jobs.publishGitHub(makeGitHubJob(principal.tenantId, sourceId, run.id)); }
    catch { /* Pending run can be retried with the same endpoint and job ID. */ }
    return run;
  }

  @Get('source-runs')
  async sourceRuns(@Req() request: Request): Promise<SourceRunRow[]> {
    const principal = await this.principal(request);
    return this.db.tenant(principal.tenantId, client => this.db.rows<SourceRunRow>(client,
      "SELECT r.id, r.source_id, r.status, r.documents_seen, r.documents_new, r.documents_updated, r.pages_fetched, r.pull_requests_skipped, r.error_code, r.retry_after_at, r.started_at, r.finished_at FROM marketrift.source_runs r JOIN marketrift.sources s ON s.tenant_id = r.tenant_id AND s.id = r.source_id WHERE s.source_type = 'github_issues' ORDER BY r.started_at DESC LIMIT 50"));
  }

  @Post('imports/reviews')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 1024 * 1024, files: 1 } }))
  async importReviews(@Req() request: Request, @Body('source_id') sourceValue: unknown, @UploadedFile() file?: Express.Multer.File): Promise<{ id: string; status: 'pending_or_queued' }> {
    const principal = await this.principal(request, ['owner', 'admin', 'analyst']);
    const sourceId = input(uuid, sourceValue);
    if (!file) throw new BadRequestException('CSV file required');
    let rawRows: unknown;
    try { rawRows = parse(file.buffer, { columns: true, bom: true, skip_empty_lines: true, max_record_size: 12000 }); }
    catch { throw new BadRequestException('Invalid CSV'); }
    if (!Array.isArray(rawRows) || rawRows.length === 0 || rawRows.length > 100) throw new BadRequestException('CSV must contain 1 to 100 rows');
    const rows = rawRows.map(row => input(csvRow, row));
    if (new Set(rows.map(row => row.external_key)).size !== rows.length) throw new BadRequestException('Duplicate external_key in CSV');
    const created = await this.db.tenant(principal.tenantId, async client => {
      const sources = await this.db.rows<{ id: string }>(client,
        "SELECT id FROM marketrift.sources WHERE id = $1 AND source_type = 'manual_review'", [sourceId]);
      if (!sources[0]) throw new NotFoundException('Source not found');
      const importId = randomUUID();
      await client.query('INSERT INTO marketrift.imports (id, tenant_id, source_id, idempotency_key, total_rows) VALUES ($1, $2, $3, $4, $5)',
        [importId, principal.tenantId, sourceId, `import-${importId}-v1`, rows.length]);
      for (const row of rows) await client.query(
        'INSERT INTO marketrift.import_rows (tenant_id, import_id, external_key, source_url, published_at, body, synthetic) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [principal.tenantId, importId, row.external_key, row.source_url, row.published_at, row.body, row.synthetic === 'true']);
      return importId;
    });
    const job = makeJob(principal.tenantId, created, sourceId);
    try {
      await this.jobs.publish(job);
      await this.db.tenant(principal.tenantId, client => client.query("UPDATE marketrift.imports SET status = 'queued' WHERE id = $1 AND status = 'pending'", [created]));
    } catch { /* Remains pending for explicit retry; status is the source of truth. */ }
    return { id: created, status: 'pending_or_queued' };
  }

  @Post('imports/:id/requeue')
  @HttpCode(200)
  async requeue(@Req() request: Request, @Param('id') idValue: string): Promise<{ status: 'completed' | 'queued' }> {
    const principal = await this.principal(request, ['owner', 'admin', 'analyst']);
    const id = input(uuid, idValue);
    const rows = await this.db.tenant(principal.tenantId, client => this.db.rows<{ source_id: string; status: string }>(client,
      'SELECT source_id, status FROM marketrift.imports WHERE id = $1', [id]));
    if (!rows[0]) throw new NotFoundException();
    if (rows[0].status === 'completed') return { status: 'completed' };
    await this.jobs.publish(makeJob(principal.tenantId, id, rows[0].source_id));
    await this.db.tenant(principal.tenantId, client => client.query("UPDATE marketrift.imports SET status = 'queued' WHERE id = $1 AND status = 'pending'", [id]));
    return { status: 'queued' };
  }

  @Get('imports')
  async imports(@Req() request: Request): Promise<ImportRow[]> {
    const principal = await this.principal(request);
    return this.db.tenant(principal.tenantId, client => this.db.rows<ImportRow>(client,
      'SELECT id, source_id, status, total_rows, processed_rows, last_error, created_at, finished_at FROM marketrift.imports ORDER BY created_at DESC LIMIT 50'));
  }

  @Get('imports/:id')
  async importById(@Req() request: Request, @Param('id') idValue: string): Promise<ImportRow> {
    const principal = await this.principal(request);
    const id = input(uuid, idValue);
    const rows = await this.db.tenant(principal.tenantId, client => this.db.rows<ImportRow>(client,
      'SELECT id, source_id, status, total_rows, processed_rows, last_error, created_at, finished_at FROM marketrift.imports WHERE id = $1', [id]));
    if (!rows[0]) throw new NotFoundException();
    return rows[0];
  }

  @Get('documents')
  async documents(@Req() request: Request): Promise<DocumentRow[]> {
    const principal = await this.principal(request);
    return this.db.tenant(principal.tenantId, client => this.db.rows<DocumentRow>(client,
      `SELECT d.id, d.source_id, s.product_id, d.document_type, d.external_key, d.source_url, d.body,
        d.source_title, d.source_body, d.source_state, d.source_repository, d.source_created_at, d.source_updated_at,
        d.published_at, d.collected_at, d.synthetic, a.status AS analysis_status,
        a.model_id AS analysis_model, a.last_error AS analysis_error,
        COALESCE((SELECT json_agg(json_build_object('category', i.category,
          'sentiment', i.sentiment, 'severity', i.severity, 'description', i.pain_point,
          'evidence_quote', i.evidence_quote) ORDER BY i.issue_index)
          FROM marketrift.insights i WHERE i.tenant_id = d.tenant_id AND i.analysis_id = a.id
          AND a.status = 'completed'), '[]'::json) AS issues
        FROM marketrift.documents d
        JOIN marketrift.sources s ON s.tenant_id = d.tenant_id AND s.id = d.source_id
        LEFT JOIN marketrift.document_analyses a ON a.tenant_id = d.tenant_id
          AND a.document_id = d.id AND a.extractor_version = $1
        ORDER BY d.collected_at DESC, d.id LIMIT 100`, [activeExtractorVersion]));
  }

  @Post('documents/:id/analyze')
  @HttpCode(200)
  async reanalyze(@Req() request: Request, @Param('id') idValue: string): Promise<{ status: string }> {
    const principal = await this.principal(request, ['owner', 'admin', 'analyst']);
    const id = input(uuid, idValue);
    const status = await this.db.tenant(principal.tenantId, async client => {
      const document = await this.db.rows<{ id: string }>(client,
        "SELECT id FROM marketrift.documents WHERE id = $1 AND document_type = 'review'", [id]);
      if (!document[0]) throw new NotFoundException('Review not found');
      await client.query(
        'INSERT INTO marketrift.document_analyses (tenant_id, document_id, extractor_version) '
        + 'VALUES ($1, $2, $3) ON CONFLICT (tenant_id, document_id, extractor_version) DO NOTHING',
        [principal.tenantId, id, activeExtractorVersion]);
      const rows = await this.db.rows<{ status: string }>(client,
        'SELECT status FROM marketrift.document_analyses WHERE document_id = $1 AND extractor_version = $2 FOR UPDATE',
        [id, activeExtractorVersion]);
      if (rows[0]!.status === 'failed' || rows[0]!.status === 'unavailable') {
        await client.query("UPDATE marketrift.document_analyses SET status = 'pending', last_error = NULL, queued_at = now() WHERE document_id = $1 AND extractor_version = $2", [id, activeExtractorVersion]);
        return 'pending';
      }
      return rows[0]!.status;
    });
    if (status === 'pending') await this.jobs.publishAnalysis(makeAnalysisJob(principal.tenantId, id));
    return { status: status === 'pending' ? 'queued' : status };
  }
}
