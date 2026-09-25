import { BadRequestException, Body, Controller, Get, Inject, Post, Query, Req, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import type { QueryResultRow } from 'pg';
import { z } from 'zod';
import { Accounts } from './accounts';
import { Db } from './db';
import { sourceIndexStatus, type SourceIndexStatus } from './index-status';
import { Jobs } from './queue';

const uuid = z.uuid();
const questionSchema = z.object({ question: z.string().trim().min(3).max(500),
  product_id: uuid.optional(),
  source_type: z.enum(['review', 'b2b_review', 'github_issue', 'github_discussion',
    'pricing_page', 'release_notes']).optional(),
  from: z.iso.date().optional(), to: z.iso.date().optional(),
  include_synthetic: z.boolean().default(false), limit: z.literal(1).default(1),
}).strict().refine(value => !value.from || !value.to || value.from <= value.to,
  { message: 'Invalid period' });

type SearchInput = z.infer<typeof questionSchema>;
type ChunkRow = QueryResultRow & { id: string; source_id: string; product_id: string; product_name: string;
  document_id: string | null; snapshot_id: string | null; source_type: string; source_url: string;
  observed_at: Date; text_content: string; synthetic: boolean; data_status: string | null;
  distance: number; origin_key: string;
  associated_products: number };
type Citation = { id: string; source_type: string; product_name: string; source_url: string;
  observed_at: Date; quote: string; synthetic: boolean; data_status: string | null;
  ambiguous_association: boolean; distance: number };
type Embedding = { model: string; version: string; dimensions: number; vector: number[]; test_only: boolean };
type ModelStatus = Omit<Embedding, 'vector'>;
const localModel = 'sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2';
const localRevision = 'e8f8c211226b894fcb81acc59f3b34ba3efd5f42';
const statusSchema = z.object({ model: z.string(), version: z.string(), dimensions: z.literal(384),
  test_only: z.boolean() });

function input(value: unknown): SearchInput {
  const result = questionSchema.safeParse(value);
  if (!result.success) throw new BadRequestException(result.error.issues.map(issue => issue.message));
  return result.data;
}

export function extractiveAnswer(citations: Citation[], selectedIds: string[]): string {
  if (!selectedIds.every(id => citations.some(citation => citation.id === id)))
    throw new BadRequestException('Citation was not retrieved');
  if (!selectedIds.length) return 'Não há evidência suficiente nos trechos elegíveis indexados.';
  return selectedIds.map(id => {
    const citation = citations.find(item => item.id === id)!;
    return `Trecho da fonte ${citation.source_type}: “${citation.quote}” [${id}].`;
  }).join('\n');
}

async function internalEmbedding(path: string, text?: string): Promise<unknown> {
  const token = process.env.EMBEDDING_INTERNAL_TOKEN;
  const base = process.env.EMBEDDING_INTERNAL_URL ?? 'http://127.0.0.1:8000';
  if (!token || (process.env.NODE_ENV === 'production' && (token.length < 32 || token.startsWith('replace-with-')))
    || !/^http:\/\/(127\.0\.0\.1|localhost):\d{2,5}$/.test(base))
    throw new ServiceUnavailableException('Serviço de embeddings local não configurado');
  try {
    const response = await fetch(`${base}${path}`, {
      method: text === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Token': token },
      body: text === undefined ? undefined : JSON.stringify({ text }),
      signal: AbortSignal.timeout(60000),
    });
    if (!response.ok) {
      const value: unknown = await response.json().catch(() => null);
      if (response.status === 503 && typeof value === 'object' && value !== null && 'detail' in value &&
        typeof value.detail === 'string' && value.detail.startsWith('local_embedding_'))
        throw new ServiceUnavailableException('Modelo local ausente, incompleto ou incompatível; execute prepare:embeddings');
      throw new Error('embedding_unavailable');
    }
    return await response.json();
  } catch (error) {
    if (error instanceof ServiceUnavailableException) throw error;
    throw new ServiceUnavailableException(process.env.EMBEDDING_PROVIDER === 'local' ?
      'Modelo local indisponível; confira prepare:embeddings e reinicie intelligence-http' :
      'Serviço de embeddings local indisponível');
  }
}

export function assertActiveModel(value: ModelStatus): void {
  const provider = process.env.EMBEDDING_PROVIDER ?? 'controlled';
  const expected = provider === 'local' ? [localModel, localRevision] :
    provider === 'controlled' ? ['controlled-hash-TESTE', '1'] : [];
  if (value.model !== expected[0] || value.version !== expected[1] ||
    value.test_only !== (provider === 'controlled'))
    throw new ServiceUnavailableException('Versão do modelo de embeddings incompatível entre API e serviço local');
}

async function embeddingFor(text: string): Promise<Embedding> {
  const value = statusSchema.extend({ vector: z.array(z.number().finite()).length(384) })
    .parse(await internalEmbedding('/internal/embeddings', text));
  assertActiveModel(value);
  return value;
}

async function activeModelStatus(): Promise<ModelStatus> {
  const value = statusSchema.parse(await internalEmbedding('/internal/embeddings/status'));
  assertActiveModel(value);
  return value;
}

const searchSql = `SELECT e.id, e.source_id, e.product_id, p.name AS product_name,
  e.document_id, e.snapshot_id, e.source_type, coalesce(d.source_url, ss.final_url) AS source_url,
  coalesce(d.published_at, d.source_created_at, ss.fetched_at, d.collected_at) AS observed_at,
  e.text_content, e.synthetic, d.review_data_status AS data_status,
  (e.embedding <=> $1::vector)::float AS distance,
  CASE WHEN d.id IS NOT NULL THEN
    CASE d.document_type
      WHEN 'steam_review' THEN jsonb_build_array(d.steam_app_id, d.external_key)::text
      WHEN 'github_issue' THEN jsonb_build_array(d.source_repository, d.external_key)::text
      WHEN 'github_discussion' THEN jsonb_build_array(d.source_repository, d.external_key)::text
      ELSE jsonb_build_array(d.source_url, d.external_key)::text END
    ELSE jsonb_build_array(ss.final_url, ss.content_sha256)::text END AS origin_key,
  CASE WHEN d.id IS NOT NULL THEN
    (SELECT count(DISTINCT s2.product_id)::integer FROM marketrift.documents d2
      JOIN marketrift.sources s2 ON s2.tenant_id = d2.tenant_id AND s2.id = d2.source_id
      WHERE d2.tenant_id = e.tenant_id AND d2.document_type = d.document_type
        AND d2.external_key = d.external_key
        AND (CASE WHEN d.document_type IN ('github_issue', 'github_discussion')
          THEN d2.source_repository = d.source_repository ELSE d2.source_url = d.source_url END))
    ELSE (SELECT count(DISTINCT s2.product_id)::integer FROM marketrift.source_snapshots ss2
      JOIN marketrift.sources s2 ON s2.tenant_id = ss2.tenant_id AND s2.id = ss2.source_id
      WHERE ss2.tenant_id = e.tenant_id AND ss2.final_url = ss.final_url
        AND ss2.content_sha256 = ss.content_sha256) END AS associated_products
FROM marketrift.evidence_chunks e
JOIN marketrift.sources s ON s.tenant_id = e.tenant_id AND s.id = e.source_id
JOIN marketrift.products p ON p.tenant_id = e.tenant_id AND p.id = e.product_id
LEFT JOIN marketrift.documents d ON d.tenant_id = e.tenant_id AND d.id = e.document_id
LEFT JOIN marketrift.source_snapshots ss ON ss.tenant_id = e.tenant_id AND ss.id = e.snapshot_id
WHERE e.status = 'ready' AND s.enabled AND e.product_id = s.product_id
  AND e.embedding_model = $2 AND e.embedding_version = $3
  AND ($4::uuid IS NULL OR e.product_id = $4)
  AND ($5::text IS NULL OR e.source_type = $5)
  AND ($6::date IS NULL OR coalesce(d.published_at, d.source_created_at, ss.fetched_at, d.collected_at) >= $6::date)
  AND ($7::date IS NULL OR coalesce(d.published_at, d.source_created_at, ss.fetched_at, d.collected_at) < $7::date + interval '1 day')
  AND ($8::boolean OR NOT e.synthetic)
  AND ((d.id IS NOT NULL AND e.source_type = d.document_type
      AND e.content_version = md5(d.body) AND strpos(d.body, e.text_content) > 0
      AND ((d.document_type IN ('github_issue', 'github_discussion') AND s.source_type IN ('github_issues', 'github_discussions'))
        OR (d.document_type = 'review' AND d.synthetic AND d.review_data_status = 'synthetic_fixture')
        OR (d.document_type = 'b2b_review' AND s.source_type = 'b2b_csv_review'
          AND s.storage_permitted AND s.rights_reference IS NOT NULL
          AND ((d.synthetic AND d.review_data_status = 'synthetic_fixture') OR
            (NOT d.synthetic AND d.review_data_status = 'declared_real' AND s.access_environment = 'production'
              AND (s.rights_expires_at IS NULL OR s.rights_expires_at > now()))))))
    OR (ss.id IS NOT NULL AND e.source_type = s.source_type
      AND e.content_version = md5(ss.normalized_text)
      AND strpos(ss.normalized_text, e.text_content) > 0
      AND s.source_type IN ('pricing_page', 'release_notes')
      AND ss.interpretation_version >= 2 AND ss.interpretation_status = 'confirmed'))
ORDER BY e.embedding <=> $1::vector, e.id LIMIT 80`;

@Controller('v1/evidence')
export class SemanticController {
  constructor(@Inject(Db) private readonly db: Db, @Inject(Accounts) private readonly accounts: Accounts,
    @Inject(Jobs) private readonly jobs: Jobs) {}

  @Get('index-status')
  async indexStatus(@Req() request: Request, @Query() query: unknown): Promise<{
    model: string; model_version: string; test_only: boolean; sources: SourceIndexStatus[];
  }> {
    const principal = await this.accounts.principal(request);
    const parsed = z.object({ source_id: uuid.optional() }).strict().safeParse(query);
    if (!parsed.success) throw new BadRequestException('Invalid source_id');
    const active = await activeModelStatus();
    const sources = await this.db.tenant(principal.tenantId, client =>
      sourceIndexStatus(this.db, client, active.model, active.version, parsed.data.source_id));
    return { model: active.model, model_version: active.version, test_only: active.test_only, sources };
  }

  @Post('reindex')
  async requestIndex(@Req() request: Request, @Body() body: unknown): Promise<{ status: 'queued' }> {
    const principal = await this.accounts.principal(request, ['owner', 'admin', 'analyst']);
    const parsed = z.object({ source_id: uuid }).strict().safeParse(body);
    if (!parsed.success) throw new BadRequestException('Invalid source_id');
    const exists = await this.db.tenant(principal.tenantId, async client =>
      (await this.db.rows<{ id: string }>(client,
        'SELECT id FROM marketrift.sources WHERE id = $1 AND enabled', [parsed.data.source_id])).length > 0);
    if (!exists) throw new BadRequestException('Source not available in active company');
    await this.jobs.publishEvidenceIndex(principal.tenantId, parsed.data.source_id,
      `index:${parsed.data.source_id}:${randomUUID()}`);
    return { status: 'queued' };
  }

  @Post('questions')
  async ask(@Req() request: Request, @Body() body: unknown): Promise<{
    answer: string; citations: Citation[]; model: string; model_version: string;
    test_only: boolean; elapsed_ms: number; cost_usd: 0;
  }> {
    const start = performance.now();
    const principal = await this.accounts.principal(request);
    const f = input(body);
    const embedded = await embeddingFor(f.question);
    const vector = `[${embedded.vector.join(',')}]`;
    const rows = await this.db.tenant(principal.tenantId, client => this.db.rows<ChunkRow>(client, searchSql,
      [vector, embedded.model, embedded.version, f.product_id ?? null, f.source_type ?? null,
        f.from ?? null, f.to ?? null, f.include_synthetic]));
    const seen = new Set<string>();
    const citations: Citation[] = [];
    for (const row of rows) {
      const key = `${row.source_type}:${row.origin_key}`;
      if (seen.has(key) || row.distance > 0.85 || !row.source_url) continue;
      seen.add(key);
      citations.push({ id: row.id, source_type: row.source_type, product_name: row.product_name,
        source_url: row.source_url, observed_at: row.observed_at, quote: row.text_content,
        synthetic: row.synthetic, data_status: row.data_status,
        ambiguous_association: row.associated_products > 1,
        distance: row.distance });
      if (citations.length >= f.limit) break;
    }
    const answer = extractiveAnswer(citations, citations.map(item => item.id));
    return { answer, citations, model: embedded.model, model_version: embedded.version,
      test_only: embedded.test_only || f.include_synthetic, elapsed_ms: Math.round(performance.now() - start),
      cost_usd: 0 };
  }
}
