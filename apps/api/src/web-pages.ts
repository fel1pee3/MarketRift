import { BadRequestException, Body, ConflictException, Controller, Get, HttpCode, Inject, NotFoundException, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import type { QueryResultRow } from 'pg';
import { z } from 'zod';
import { Accounts } from './accounts';
import { Db } from './db';
import { Jobs } from './queue';
import { makeWebPageJob } from './web-page-job';
import { publicPageUrl } from './web-page-url';

const uuid = z.uuid();
const createInput = z.object({ product_id: uuid, url: z.string().min(1).max(2048),
  source_type: z.enum(['pricing_page', 'release_notes']),
  check_interval_minutes: z.union([z.literal(60), z.literal(360), z.literal(1440), z.literal(10080)]),
}).strict();
type Source = QueryResultRow & { id: string; product_id: string; product_name: string; source_type: string;
  url: string; check_interval_minutes: number; last_checked_at: Date | null };
type Run = QueryResultRow & { id: string; source_id: string; status: string; error_code: string | null;
  retry_after_at: Date | null; documents_new: number; started_at: Date; finished_at: Date | null };
type Snapshot = QueryResultRow & { id: string; source_id: string; version_no: number; final_url: string;
  content_sha256: string; normalized_text: string; extracted: object; fetched_at: Date };
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

  @Post()
  async create(@Req() request: Request, @Body() body: unknown): Promise<Omit<Source, 'product_name'>> {
    const principal = await this.accounts.principal(request, ['owner', 'admin']);
    const data = parse(createInput, body);
    const url = publicPageUrl(data.url);
    try {
      return await this.db.tenant(principal.tenantId, async client => {
        const rows = await this.db.rows<Source>(client,
          "INSERT INTO marketrift.sources (tenant_id, product_id, source_type, url, check_interval_minutes) "
          + "SELECT $1, id, $3, $4, $5 FROM marketrift.products WHERE tenant_id = $1 AND id = $2 "
          + "RETURNING id, product_id, source_type, url, check_interval_minutes, last_checked_at",
          [principal.tenantId, data.product_id, data.source_type, url, data.check_interval_minutes]);
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
  async list(@Req() request: Request): Promise<{ sources: Source[]; runs: Run[]; snapshots: Snapshot[]; changes: Change[] }> {
    const principal = await this.accounts.principal(request);
    return this.db.tenant(principal.tenantId, async client => {
      const sources = await this.db.rows<Source>(client,
        "SELECT s.id, s.product_id, p.name AS product_name, s.source_type, s.url, "
        + "s.check_interval_minutes, s.last_checked_at FROM marketrift.sources s "
        + "JOIN marketrift.products p ON p.tenant_id = s.tenant_id AND p.id = s.product_id "
        + "WHERE s.source_type IN ('pricing_page', 'release_notes') ORDER BY s.id");
      const runs = await this.db.rows<Run>(client,
        "SELECT r.id, r.source_id, r.status, r.error_code, r.retry_after_at, r.documents_new, "
        + "r.started_at, r.finished_at FROM marketrift.source_runs r JOIN marketrift.sources s "
        + "ON s.tenant_id = r.tenant_id AND s.id = r.source_id "
        + "WHERE r.run_kind = 'web_page' ORDER BY r.started_at DESC LIMIT 100");
      const snapshots = await this.db.rows<Snapshot>(client,
        "SELECT ss.id, ss.source_id, ss.version_no, ss.final_url, ss.content_sha256, "
        + "ss.normalized_text, ss.extracted, ss.fetched_at FROM marketrift.source_snapshots ss "
        + "WHERE ss.extracted IS NOT NULL ORDER BY ss.fetched_at DESC LIMIT 100");
      const changes = await this.db.rows<Change>(client,
        'SELECT id, source_id, previous_snapshot_id, current_snapshot_id, change_details, detected_at '
        + 'FROM marketrift.page_changes ORDER BY detected_at DESC LIMIT 100');
      return { sources, runs, snapshots, changes };
    });
  }

  @Post(':id/check')
  @HttpCode(200)
  async check(@Req() request: Request, @Param('id') value: string): Promise<{ id: string; status: string }> {
    const principal = await this.accounts.principal(request, ['owner', 'admin', 'analyst']);
    const sourceId = parse(uuid, value);
    const run = await this.db.tenant(principal.tenantId, async client => {
      const source = await this.db.rows<{ id: string }>(client,
        "SELECT id FROM marketrift.sources WHERE tenant_id = $1 AND id = $2 "
        + "AND source_type IN ('pricing_page', 'release_notes') AND enabled = true FOR UPDATE",
        [principal.tenantId, sourceId]);
      if (!source[0]) throw new NotFoundException('Page source not found in active company');
      await client.query("UPDATE marketrift.source_runs SET status = 'failed', error_code = 'worker_timeout', finished_at = now() "
        + "WHERE tenant_id = $1 AND source_id = $2 AND run_kind = 'web_page' AND status = 'running' "
        + "AND started_at < now() - interval '10 minutes'", [principal.tenantId, sourceId]);
      const active = await this.db.rows<{ id: string; status: string }>(client,
        "SELECT id, status FROM marketrift.source_runs WHERE tenant_id = $1 AND source_id = $2 "
        + "AND run_kind = 'web_page' AND status IN ('pending', 'running') LIMIT 1",
        [principal.tenantId, sourceId]);
      if (active[0]) {
        if (active[0].status === 'running') throw new ConflictException('Check already running');
        return active[0];
      }
      const blocked = await this.db.rows<{ retry_after_at: Date }>(client,
        'SELECT retry_after_at FROM marketrift.source_runs WHERE tenant_id = $1 AND source_id = $2 '
        + 'AND retry_after_at > now() ORDER BY retry_after_at DESC LIMIT 1',
        [principal.tenantId, sourceId]);
      if (blocked[0]) throw new ConflictException(`Source retry after ${blocked[0].retry_after_at.toISOString()}`);
      const recent = await this.db.rows<{ finished_at: Date }>(client,
        "SELECT finished_at FROM marketrift.source_runs WHERE tenant_id = $1 AND source_id = $2 "
        + "AND run_kind = 'web_page' AND finished_at > now() - interval '1 minute' "
        + 'ORDER BY finished_at DESC LIMIT 1', [principal.tenantId, sourceId]);
      if (recent[0]) throw new ConflictException('Wait at least one minute between page checks');
      const rows = await this.db.rows<{ id: string; status: string }>(client,
        "INSERT INTO marketrift.source_runs (tenant_id, source_id, status, run_kind) "
        + "VALUES ($1, $2, 'pending', 'web_page') RETURNING id, status", [principal.tenantId, sourceId]);
      return rows[0]!;
    });
    try { await this.jobs.publishWebPage(makeWebPageJob(principal.tenantId, sourceId, run.id)); }
    catch { /* A pending run can be published again with the same ID. */ }
    return run;
  }
}
