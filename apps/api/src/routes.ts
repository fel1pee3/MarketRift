import { BadRequestException, ConflictException, Controller, ForbiddenException, Get, Headers, HttpCode, Inject, NotFoundException, Param, Post, Body, Req, UploadedFile, UseInterceptors, UnauthorizedException } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { Request } from 'express';
import { QueryResultRow } from 'pg';
import { sign, verify, JwtPayload } from 'jsonwebtoken';
import { parse } from 'csv-parse/sync';
import { z } from 'zod';
import { Db } from './db';
import { Jobs } from './queue';
import { makeJob } from './job';

const uuid = z.uuid();
const httpUrl = z.url().refine(value => /^https?:\/\//i.test(value), 'HTTP(S) URL required');
const registration = z.object({ email: z.email().max(254), password: z.string().min(12).max(200), display_name: z.string().trim().min(1).max(120), company_name: z.string().trim().min(1).max(120) }).strict();
const loginInput = z.object({ email: z.email(), password: z.string() }).strict();
const productInput = z.object({ name: z.string().trim().min(1).max(120), kind: z.enum(['own', 'competitor']), website_url: httpUrl.optional() }).strict();
const sourceInput = z.object({ product_id: uuid, url: httpUrl }).strict();
const csvRow = z.object({ external_key: z.string().trim().min(1).max(200), source_url: httpUrl, published_at: z.iso.datetime({ offset: true }), body: z.string().trim().min(1).max(10000), synthetic: z.enum(['true', 'false', '']).optional() }).strict();
type Role = 'owner' | 'admin' | 'analyst' | 'viewer';
interface Principal { userId: string; tenantId: string; role: Role }
type ProductRow = QueryResultRow & { id: string; name: string; kind: 'own' | 'competitor'; website_url: string | null };
type SourceRow = QueryResultRow & { id: string; product_id: string; source_type: 'manual_review'; url: string };
type ImportRow = QueryResultRow & { id: string; source_id: string; status: string; total_rows: number; processed_rows: number; last_error: string | null; created_at: Date; finished_at: Date | null };
type DocumentRow = QueryResultRow & { id: string; source_id: string; product_id: string; external_key: string; source_url: string; body: string; published_at: Date | null; collected_at: Date; synthetic: boolean };

function input<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new BadRequestException(parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`));
  return parsed.data;
}
function passwordHash(password: string): string {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}
function passwordMatches(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash || hash.length !== 128) return false;
  return timingSafeEqual(scryptSync(password, salt, 64), Buffer.from(hash, 'hex'));
}
function token(userId: string, tenantId: string): string {
  return sign({ tenant_id: tenantId }, process.env.JWT_SECRET!, { subject: userId, expiresIn: '12h', issuer: 'marketrift-api', audience: 'marketrift-web' });
}
function conflict(error: unknown): never {
  if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') throw new ConflictException('Resource already exists');
  throw error;
}

@Controller('v1')
export class ApiController {
  constructor(@Inject(Db) private readonly db: Db, @Inject(Jobs) private readonly jobs: Jobs) {}

  private async principal(request: Request, allowed: Role[] = ['owner', 'admin', 'analyst', 'viewer']): Promise<Principal> {
    const match = /^Bearer (\S+)$/i.exec(request.headers.authorization ?? '');
    if (!match) throw new UnauthorizedException();
    let payload: JwtPayload | string;
    try { payload = verify(match[1]!, process.env.JWT_SECRET!, { issuer: 'marketrift-api', audience: 'marketrift-web' }); }
    catch { throw new UnauthorizedException(); }
    if (typeof payload === 'string' || !uuid.safeParse(payload.sub).success || !uuid.safeParse(payload.tenant_id).success) throw new UnauthorizedException();
    const tenantId = payload.tenant_id as string;
    const userId = payload.sub!;
    const roles = await this.db.tenant(tenantId, client => this.db.rows<{ role: Role }>(client,
      'SELECT role FROM marketrift.memberships WHERE tenant_id = $1 AND user_id = $2', [tenantId, userId]));
    if (!roles[0]) throw new UnauthorizedException();
    if (!allowed.includes(roles[0].role)) throw new ForbiddenException();
    return { userId, tenantId, role: roles[0].role };
  }

  @Post('auth/register')
  async register(@Body() body: unknown): Promise<{ token: string; tenant_id: string }> {
    const data = input(registration, body);
    const client = await this.db.provisioning.connect();
    try {
      await client.query('BEGIN');
      const users = await client.query<{ id: string }>('INSERT INTO marketrift.users (email, display_name, password_hash) VALUES ($1, $2, $3) RETURNING id',
        [data.email.toLowerCase(), data.display_name, passwordHash(data.password)]);
      const tenants = await client.query<{ id: string }>('INSERT INTO marketrift.tenants (name) VALUES ($1) RETURNING id', [data.company_name]);
      const userId = users.rows[0]!.id;
      const tenantId = tenants.rows[0]!.id;
      await client.query('INSERT INTO marketrift.memberships (tenant_id, user_id, role) VALUES ($1, $2, $3)', [tenantId, userId, 'owner']);
      await client.query('COMMIT');
      return { token: token(userId, tenantId), tenant_id: tenantId };
    } catch (error) { await client.query('ROLLBACK'); return conflict(error); }
    finally { client.release(); }
  }

  @Post('auth/login')
  @HttpCode(200)
  async login(@Body() body: unknown): Promise<{ token: string; tenant_id: string }> {
    const data = input(loginInput, body);
    const result = await this.db.provisioning.query<{ id: string; password_hash: string; tenant_id: string }>(
      'SELECT u.id, u.password_hash, m.tenant_id FROM marketrift.users u JOIN marketrift.memberships m ON m.user_id = u.id WHERE u.email = $1 ORDER BY m.created_at LIMIT 1', [data.email.toLowerCase()]);
    const user = result.rows[0];
    if (!user || !passwordMatches(data.password, user.password_hash)) throw new UnauthorizedException();
    return { token: token(user.id, user.tenant_id), tenant_id: user.tenant_id };
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
