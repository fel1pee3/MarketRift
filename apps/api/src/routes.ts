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
import { Accounts, Principal, Role } from './accounts';

const uuid = z.uuid();
const httpUrl = z.url().refine(value => /^https?:\/\//i.test(value), 'HTTP(S) URL required');
const productInput = z.object({ name: z.string().trim().min(1).max(120), kind: z.enum(['own', 'competitor']), website_url: httpUrl.optional() }).strict();
const sourceInput = z.object({ product_id: uuid, url: httpUrl }).strict();
const csvRow = z.object({ external_key: z.string().trim().min(1).max(200), source_url: httpUrl, published_at: z.iso.datetime({ offset: true }), body: z.string().trim().min(1).max(10000), synthetic: z.enum(['true', 'false', '']).optional() }).strict();
type ProductRow = QueryResultRow & { id: string; name: string; kind: 'own' | 'competitor'; website_url: string | null };
type SourceRow = QueryResultRow & { id: string; product_id: string; source_type: 'manual_review'; url: string };
type ImportRow = QueryResultRow & { id: string; source_id: string; status: string; total_rows: number; processed_rows: number; last_error: string | null; created_at: Date; finished_at: Date | null };
type DocumentRow = QueryResultRow & { id: string; source_id: string; product_id: string; external_key: string; source_url: string; body: string; published_at: Date | null; collected_at: Date; synthetic: boolean };

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
      'SELECT id, product_id, source_type, url FROM marketrift.sources ORDER BY id'));
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
      'SELECT d.id, d.source_id, s.product_id, d.external_key, d.source_url, d.body, d.published_at, d.collected_at, d.synthetic FROM marketrift.documents d JOIN marketrift.sources s ON s.tenant_id = d.tenant_id AND s.id = d.source_id ORDER BY d.collected_at DESC, d.id LIMIT 100'));
  }
}
