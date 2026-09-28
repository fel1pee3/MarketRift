import { BadRequestException, Body, ConflictException, Controller, Get, Inject, NotFoundException,
  Param, Post, Req, ServiceUnavailableException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Request } from 'express';
import type { PoolClient, QueryResultRow } from 'pg';
import { z } from 'zod';
import { Accounts } from './accounts';
import { Db } from './db';

const uuid = z.uuid();
const categories = ['support', 'price', 'billing', 'performance', 'usability', 'features', 'out_of_taxonomy'] as const;
const createInput = z.object({ title: z.string().trim().min(3).max(120), origin: z.enum(['real', 'synthetic_test']),
  product_id: uuid.optional(), source_id: uuid.optional(), from: z.iso.date().optional(), to: z.iso.date().optional(),
  limit: z.number().int().min(1).max(25) }).strict().refine(f => !f.from || !f.to || f.from <= f.to);
const issueInput = z.object({ category: z.enum(categories), severity: z.enum(['low', 'medium', 'high']).nullable(),
  start: z.number().int().nonnegative(), end: z.number().int().positive(),
  outside_topic: z.string().trim().min(2).max(120).optional() }).strict();
const labelInput = z.object({ item_id: uuid, decision: z.enum(['problem', 'no_problem', 'insufficient_evidence']),
  issues: z.array(issueInput).max(8) }).strict();
const paidInput = z.object({ provider: z.literal('openai'), model: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/),
  max_examples: z.number().int().min(1).max(3), max_output_tokens: z.number().int().min(128).max(512),
  budget_usd: z.number().positive().max(0.05), input_usd_per_million: z.number().positive(),
  output_usd_per_million: z.number().positive(), confirmation: z.literal('AUTORIZO AVALIACAO PAGA') }).strict();
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new BadRequestException(result.error.issues.map(i => i.message));
  return result.data;
}
function sha(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function stable(value: unknown): string { return JSON.stringify(value); }
type SetRow = QueryResultRow & { id: string; tenant_id: string; title: string; origin: 'real' | 'synthetic_test';
  version: number; status: 'draft' | 'frozen' | 'purged'; corpus_hash: string | null; judgment_hash: string | null };
type ItemRow = QueryResultRow & { id: string; document_id: string; source_id: string; content_hash: string;
  metadata_hash: string; body: string | null; external_key: string | null; source_url: string | null;
  published_at: Date | null; review_language: string | null; synthetic: boolean | null;
  review_data_status: string | null; enabled: boolean | null; storage_permitted: boolean | null;
  access_environment: string | null; rights_reference: string | null; rights_expires_at: Date | null;
  external_ai_permitted: boolean | null; ai_provider: string | null; ai_rights_reference: string | null;
  ai_rights_expires_at: Date | null; ai_rights_revoked_at: Date | null };
type LabelRow = QueryResultRow & { item_id: string; decision: 'problem' | 'no_problem' | 'insufficient_evidence';
  issues: z.infer<typeof issueInput>[]; reviewer_id: string; revision: number; judged_at: Date };
type ReportRow = QueryResultRow & { id: string; status: string; provider: string; model: string;
  result: Record<string, unknown> | null; error_code: string | null; created_at: Date };

class LocalEvaluatorError extends ServiceUnavailableException {
  constructor(readonly reason: string, message: string) { super(message); }
}

export function labelProblems(body: string, decision: z.infer<typeof labelInput>['decision'],
  issues: z.infer<typeof issueInput>[]): void {
  if ((decision === 'problem') !== (issues.length > 0)) throw new BadRequestException('Problema exige ao menos um trecho; outras decisões não aceitam problemas');
  const seen = new Set<string>();
  for (const issue of issues) {
    if (issue.end <= issue.start || issue.end > body.length || issue.end - issue.start < 3 || issue.end - issue.start > 500 ||
      !body.slice(issue.start, issue.end).trim()) throw new BadRequestException('Trecho literal inválido ou fora da review');
    if (issue.outside_topic && issue.category !== 'out_of_taxonomy') throw new BadRequestException('Tema fora da taxonomia exige categoria própria');
    const key = `${issue.category}:${issue.start}:${issue.end}`;
    if (seen.has(key)) throw new BadRequestException('Problema duplicado');
    seen.add(key);
  }
}
export function conservativeCost(texts: string[], outputTokens: number, inputRate: number, outputRate: number): number {
  const input = texts.reduce((sum, body) => sum + 16000 + 2 * Buffer.byteLength(body, 'utf8'), 0);
  return (input * inputRate + texts.length * outputTokens * outputRate) / 1_000_000;
}
function metadata(row: ItemRow): string {
  return sha(stable([row.external_key, row.source_url, row.published_at?.toISOString() ?? null,
    row.review_language, row.synthetic, row.review_data_status]));
}
export function eligibility(row: ItemRow, origin: SetRow['origin'], now = new Date()): string | null {
  if (!row.body || !row.enabled || !row.storage_permitted || !row.rights_reference) return 'review_removed_or_storage_revoked';
  if (row.access_environment !== (origin === 'real' ? 'production' : 'sandbox') ||
      row.synthetic !== (origin === 'synthetic_test') ||
      row.review_data_status !== (origin === 'real' ? 'declared_real' : 'synthetic_fixture')) return 'origin_changed';
  if (origin === 'real' && (!row.rights_expires_at || row.rights_expires_at <= now)) return 'storage_rights_expired';
  if (sha(row.body) !== row.content_hash || metadata(row) !== row.metadata_hash) return 'review_version_changed';
  return null;
}
export function externalRights(row: ItemRow, now = new Date()): boolean {
  return row.access_environment === 'production' && !!row.external_ai_permitted &&
    row.ai_provider === 'openai' && !!row.ai_rights_reference &&
    !!row.ai_rights_expires_at && row.ai_rights_expires_at > now && !row.ai_rights_revoked_at;
}
const itemsSql = `SELECT i.id,i.document_id,i.source_id,i.content_hash,i.metadata_hash,
  d.body,d.external_key,d.source_url,d.published_at,d.review_language,d.synthetic,d.review_data_status,
  s.enabled,s.storage_permitted,s.access_environment,s.rights_reference,s.rights_expires_at,
  s.external_ai_permitted,s.ai_provider,s.ai_rights_reference,s.ai_rights_expires_at,s.ai_rights_revoked_at
  FROM marketrift.b2b_quality_items i
  LEFT JOIN marketrift.documents d ON d.tenant_id=i.tenant_id AND d.id=i.document_id
    AND d.source_id=i.source_id AND d.document_type='b2b_review'
  LEFT JOIN marketrift.sources s ON s.tenant_id=i.tenant_id AND s.id=i.source_id
    AND s.source_type='b2b_csv_review'
  WHERE i.set_id=$1 ORDER BY i.id`;

export async function internalEvaluate(dataset: Record<string, unknown>, settings: Record<string, unknown>): Promise<Record<string, unknown>> {
  const base = process.env.EMBEDDING_INTERNAL_URL ?? 'http://127.0.0.1:8000';
  const token = process.env.EMBEDDING_INTERNAL_TOKEN;
  if (!token || !/^http:\/\/(127\.0\.0\.1|localhost):\d{2,5}$/.test(base))
    throw new LocalEvaluatorError('local_configuration_missing',
      'Configure EMBEDDING_INTERNAL_URL e EMBEDDING_INTERNAL_TOKEN na API e reinicie-a');
  try {
    const response = await fetch(`${base}/internal/b2b-quality/evaluate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Internal-Token': token },
      body: JSON.stringify({ dataset, settings }), signal: AbortSignal.timeout(180000),
    });
    if (!response.ok) {
      // Never echo the remote response: validation details may contain review text.
      if (response.status === 401) throw new LocalEvaluatorError('internal_auth_failed',
        'Token interno da API e do FastAPI não coincide; reinicie os dois serviços com a mesma configuração');
      if (response.status === 404) throw new LocalEvaluatorError('evaluator_endpoint_missing',
        'FastAPI está ativo, mas não oferece esta rota de avaliação; reinicie o serviço HTTP atualizado');
      if (response.status === 400) throw new LocalEvaluatorError('invalid_quality_contract',
        'FastAPI recusou o contrato do conjunto; confira a versão da API e do serviço HTTP');
      if (response.status === 503) throw new LocalEvaluatorError('evaluator_not_ready',
        'FastAPI está ativo, mas o avaliador local não está pronto');
      throw new LocalEvaluatorError(`internal_http_${response.status}`,
        `FastAPI respondeu HTTP ${response.status} à avaliação local`);
    }
    try { return await response.json() as Record<string, unknown>; }
    catch { throw new LocalEvaluatorError('invalid_evaluator_response',
      'FastAPI retornou uma resposta inválida; reinicie o serviço HTTP atualizado'); }
  } catch (error) {
    if (error instanceof LocalEvaluatorError) throw error;
    if (error instanceof Error && error.name === 'TimeoutError')
      throw new LocalEvaluatorError('evaluator_timeout', 'FastAPI não concluiu a avaliação no tempo limite');
    throw new LocalEvaluatorError('evaluator_unreachable',
      'FastAPI não está acessível. Inicie npm run dev:intelligence-http e tente novamente');
  }
}

@Controller('v1/b2b-quality')
export class B2BQualityController {
  constructor(@Inject(Db) private readonly db: Db, @Inject(Accounts) private readonly accounts: Accounts) {}
  private async one(client: PoolClient, id: string, lock = false): Promise<SetRow> {
    const [set] = await this.db.rows<SetRow>(client,
      `SELECT * FROM marketrift.b2b_quality_sets WHERE id=$1${lock ? ' FOR UPDATE' : ''}`, [parse(uuid, id)]);
    if (!set) throw new NotFoundException('Conjunto inexistente na empresa ativa');
    return set;
  }
  private async items(client: PoolClient, id: string): Promise<ItemRow[]> {
    return this.db.rows<ItemRow>(client, itemsSql, [id]);
  }
  private async labels(client: PoolClient, id: string): Promise<LabelRow[]> {
    return this.db.rows<LabelRow>(client, 'SELECT * FROM marketrift.b2b_quality_labels WHERE set_id=$1 ORDER BY item_id', [id]);
  }

  @Get('sets')
  async list(@Req() request: Request) {
    const principal = await this.accounts.principal(request);
    return this.db.tenant(principal.tenantId, client => this.db.rows<SetRow>(client,
      'SELECT * FROM marketrift.b2b_quality_sets ORDER BY created_at DESC LIMIT 50'));
  }

  @Get('summary')
  async summary(@Req() request: Request) {
    const principal = await this.accounts.principal(request);
    return this.db.tenant(principal.tenantId, async client => {
      const [counts] = await this.db.rows<{ real_reviews: number; real_human_labels: number }>(client, `SELECT
        (SELECT count(*)::integer FROM marketrift.documents d JOIN marketrift.sources s
          ON s.tenant_id=d.tenant_id AND s.id=d.source_id WHERE d.document_type='b2b_review'
          AND NOT d.synthetic AND d.review_data_status='declared_real' AND s.enabled AND s.storage_permitted
          AND s.rights_reference IS NOT NULL AND s.rights_expires_at > now()) AS real_reviews,
        (SELECT count(DISTINCT d.id)::integer FROM marketrift.b2b_quality_labels l
          JOIN marketrift.b2b_quality_sets q ON q.tenant_id=l.tenant_id AND q.id=l.set_id
          JOIN marketrift.b2b_quality_items i ON i.tenant_id=l.tenant_id AND i.id=l.item_id
          JOIN marketrift.documents d ON d.tenant_id=i.tenant_id AND d.id=i.document_id
          JOIN marketrift.sources s ON s.tenant_id=d.tenant_id AND s.id=d.source_id
          WHERE q.origin='real' AND d.document_type='b2b_review' AND NOT d.synthetic
            AND d.review_data_status='declared_real' AND s.enabled AND s.storage_permitted
            AND s.rights_reference IS NOT NULL AND s.rights_expires_at > now()) AS real_human_labels`);
      return counts;
    });
  }

  @Post('sets')
  async create(@Req() request: Request, @Body() body: unknown) {
    const principal = await this.accounts.principal(request, ['owner', 'admin']);
    const f = parse(createInput, body);
    return this.db.tenant(principal.tenantId, async client => {
      if (f.product_id && !(await this.db.rows(client, 'SELECT id FROM marketrift.products WHERE id=$1', [f.product_id])).length)
        throw new BadRequestException('Produto inexistente na empresa ativa');
      if (f.source_id && !(await this.db.rows(client, `SELECT id FROM marketrift.sources WHERE id=$1
        AND source_type='b2b_csv_review' AND ($2::uuid IS NULL OR product_id=$2)`, [f.source_id, f.product_id ?? null])).length)
        throw new BadRequestException('Fonte inexistente para este produto e empresa');
      const candidates = await this.db.rows<ItemRow>(client, `SELECT d.id AS document_id,d.source_id,d.body,d.external_key,
        d.source_url,d.published_at,d.review_language,d.synthetic,d.review_data_status,
        s.enabled,s.storage_permitted,s.access_environment,s.rights_reference,s.rights_expires_at,
        s.external_ai_permitted,s.ai_provider,s.ai_rights_reference,s.ai_rights_expires_at,s.ai_rights_revoked_at
        FROM marketrift.documents d JOIN marketrift.sources s ON s.tenant_id=d.tenant_id AND s.id=d.source_id
        WHERE d.document_type='b2b_review' AND s.source_type='b2b_csv_review'
          AND s.enabled AND s.storage_permitted AND s.rights_reference IS NOT NULL
          AND ($1::uuid IS NULL OR s.product_id=$1) AND ($2::uuid IS NULL OR s.id=$2)
          AND ($3::date IS NULL OR d.published_at >= $3::date)
          AND ($4::date IS NULL OR d.published_at < $4::date + interval '1 day')
          AND (($5::text='real' AND NOT d.synthetic AND d.review_data_status='declared_real'
            AND s.access_environment='production' AND s.rights_expires_at > now())
            OR ($5::text='synthetic_test' AND d.synthetic AND d.review_data_status='synthetic_fixture'
              AND s.access_environment='sandbox'))
          AND length(d.body) BETWEEN 1 AND 10000
        ORDER BY d.published_at DESC NULLS LAST,d.id LIMIT $6`,
      [f.product_id ?? null, f.source_id ?? null, f.from ?? null, f.to ?? null, f.origin, f.limit]);
      if (!candidates.length) throw new BadRequestException('Nenhuma review B2B elegível nos filtros e direitos atuais');
      const [set] = await this.db.rows<SetRow>(client, `INSERT INTO marketrift.b2b_quality_sets
        (tenant_id,title,origin,product_id,source_id,period_from,period_to,created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [principal.tenantId, f.title, f.origin, f.product_id ?? null, f.source_id ?? null,
        f.from ?? null, f.to ?? null, principal.userId]);
      if (!set) throw new ServiceUnavailableException('Falha ao criar conjunto');
      for (const row of candidates) await client.query(`INSERT INTO marketrift.b2b_quality_items
        (tenant_id,set_id,document_id,source_id,content_hash,metadata_hash) VALUES ($1,$2,$3,$4,$5,$6)`,
      [principal.tenantId, set.id, row.document_id, row.source_id, sha(row.body!), metadata(row)]);
      return { id: set.id, items: candidates.length, origin: set.origin };
    });
  }

  @Get('sets/:id')
  async detail(@Req() request: Request, @Param('id') id: string) {
    const principal = await this.accounts.principal(request);
    return this.db.tenant(principal.tenantId, async client => {
      const set = await this.one(client, id);
      const items = await this.items(client, id);
      const labels = await this.labels(client, id);
      const reports = await this.db.rows<ReportRow>(client,
        'SELECT * FROM marketrift.b2b_quality_reports WHERE set_id=$1 ORDER BY created_at DESC', [id]);
      const visible = items.map(row => {
        const stale = eligibility(row, set.origin);
        return { id: row.id, document_id: row.document_id, source_id: row.source_id,
          content_hash: row.content_hash, eligible: !stale, stale_reason: stale,
          external_ai_eligible: !stale && set.origin === 'real' && externalRights(row),
          body: stale ? null : row.body, source_url: stale ? null : row.source_url,
          published_at: stale ? null : row.published_at, review_language: stale ? null : row.review_language };
      });
      return { set, items: visible, labels: labels.map(label => {
        const active = visible.find(item => item.id === label.item_id);
        return { ...label, issues: active?.eligible ? label.issues : [] };
      }), reports: reports.map(report => ({ ...report, stale: visible.some(item => !item.eligible) })) };
    });
  }

  @Post('sets/:id/labels')
  async label(@Req() request: Request, @Param('id') id: string, @Body() body: unknown) {
    const principal = await this.accounts.principal(request, ['owner', 'admin', 'analyst']);
    const f = parse(labelInput, body);
    return this.db.tenant(principal.tenantId, async client => {
      const set = await this.one(client, id, true);
      if (set.status !== 'draft') throw new ConflictException('Conjunto congelado; crie nova versão');
      const row = (await this.items(client, id)).find(item => item.id === f.item_id);
      if (!row) throw new NotFoundException('Review não pertence ao conjunto');
      const stale = eligibility(row, set.origin);
      if (stale) throw new ConflictException(`Review inelegível: ${stale}`);
      labelProblems(row.body!, f.decision, f.issues);
      const [label] = await this.db.rows<LabelRow>(client, `INSERT INTO marketrift.b2b_quality_labels
        (tenant_id,set_id,item_id,decision,issues,reviewer_id) VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT (tenant_id,set_id,item_id) DO UPDATE SET decision=EXCLUDED.decision,
          issues=EXCLUDED.issues,reviewer_id=EXCLUDED.reviewer_id,
          revision=marketrift.b2b_quality_labels.revision+1,judged_at=now() RETURNING *`,
      [principal.tenantId, id, f.item_id, f.decision, JSON.stringify(f.issues), principal.userId]);
      if (!label) throw new ServiceUnavailableException('Falha ao salvar julgamento');
      return { ...label, issues: label.issues };
    });
  }

  @Post('sets/:id/freeze')
  async freeze(@Req() request: Request, @Param('id') id: string) {
    const principal = await this.accounts.principal(request, ['owner', 'admin']);
    return this.db.tenant(principal.tenantId, async client => {
      const set = await this.one(client, id, true);
      if (set.status !== 'draft') throw new ConflictException('Conjunto já congelado');
      const items = await this.items(client, id);
      const labels = await this.labels(client, id);
      if (!items.length || labels.length !== items.length) throw new ConflictException('Julgue todas as reviews antes de congelar');
      if (items.some(item => eligibility(item, set.origin))) throw new ConflictException('Review editada, removida ou sem direito vigente');
      const corpus = sha(stable(items.map(item => [item.id,item.document_id,item.content_hash,item.metadata_hash])));
      const judgments = sha(stable(labels.map(label => [label.item_id,label.decision,label.issues,label.reviewer_id,label.revision])));
      const [frozen] = await this.db.rows<SetRow>(client, `UPDATE marketrift.b2b_quality_sets
        SET status='frozen',corpus_hash=$2,judgment_hash=$3,frozen_at=now() WHERE id=$1 RETURNING *`,
      [id, corpus, judgments]);
      return frozen;
    });
  }

  @Post('sets/:id/copy')
  async copy(@Req() request: Request, @Param('id') id: string) {
    const principal = await this.accounts.principal(request, ['owner', 'admin']);
    return this.db.tenant(principal.tenantId, async client => {
      const set = await this.one(client, id, true);
      if (set.status !== 'frozen') throw new ConflictException('Congele a versão antes de copiá-la');
      if ((await this.db.rows(client,
        'SELECT id FROM marketrift.b2b_quality_sets WHERE parent_set_id=$1 LIMIT 1', [id])).length)
        throw new ConflictException('Esta versão já tem sucessora; continue a partir da versão mais recente');
      const [next] = await this.db.rows<SetRow>(client, `INSERT INTO marketrift.b2b_quality_sets
        (tenant_id,title,origin,product_id,source_id,period_from,period_to,version,parent_set_id,created_by)
        SELECT tenant_id,title,origin,product_id,source_id,period_from,period_to,version+1,id,$2
        FROM marketrift.b2b_quality_sets WHERE id=$1 RETURNING *`, [id, principal.userId]);
      if (!next) throw new ServiceUnavailableException('Falha ao criar versão');
      const labels = new Map((await this.labels(client,id)).map(label => [label.item_id,label]));
      for (const row of await this.items(client,id)) {
        if (!row.body || !row.enabled || !row.storage_permitted || !row.rights_reference ||
            row.access_environment !== (set.origin === 'real' ? 'production' : 'sandbox') ||
            row.synthetic !== (set.origin === 'synthetic_test') ||
            row.review_data_status !== (set.origin === 'real' ? 'declared_real' : 'synthetic_fixture') ||
            (set.origin === 'real' && (!row.rights_expires_at || row.rights_expires_at <= new Date()))) continue;
        const [item] = await this.db.rows<{ id: string }>(client, `INSERT INTO marketrift.b2b_quality_items
          (tenant_id,set_id,document_id,source_id,content_hash,metadata_hash)
          VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [principal.tenantId,next.id,row.document_id,row.source_id,sha(row.body),metadata(row)]);
        if (!item) throw new ServiceUnavailableException('Falha ao copiar review');
        const previous = labels.get(row.id);
        if (previous && !eligibility(row,set.origin)) await client.query(`INSERT INTO marketrift.b2b_quality_labels
          (tenant_id,set_id,item_id,decision,issues,reviewer_id,revision,judged_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [principal.tenantId,next.id,item.id,previous.decision,JSON.stringify(previous.issues),
          previous.reviewer_id,previous.revision,previous.judged_at]);
      }
      if (!(await this.db.rows(client,
        'SELECT id FROM marketrift.b2b_quality_items WHERE set_id=$1 LIMIT 1', [next.id])).length)
        throw new ConflictException('Nenhuma review mantém direito de armazenamento para nova versão');
      return { id: next.id, version: next.version };
    });
  }

  private async evaluationData(client: PoolClient, set: SetRow, paid: boolean) {
    const items = await this.items(client,set.id);
    const labels = await this.labels(client,set.id);
    if (set.status !== 'frozen' || !items.length || labels.length !== items.length)
      throw new ConflictException('Congele um conjunto completamente rotulado');
    if (items.some(item => eligibility(item,set.origin))) throw new ConflictException('Review alterada, removida ou sem armazenamento vigente; relatório anterior é histórico');
    if (paid && (set.origin !== 'real' || items.some(item => !externalRights(item))))
      throw new ConflictException('Direito de envio externo ausente, vencido ou revogado');
    if (!paid && set.origin !== 'synthetic_test') throw new BadRequestException('Modo controlado aceita somente conjunto TESTE');
    const corpus = sha(stable(items.map(item => [item.id,item.document_id,item.content_hash,item.metadata_hash])));
    const judgments = sha(stable(labels.map(label => [label.item_id,label.decision,label.issues,label.reviewer_id,label.revision])));
    if (corpus !== set.corpus_hash || judgments !== set.judgment_hash)
      throw new ConflictException('Hashes do conjunto congelado divergentes');
    const byId = new Map(labels.map(label => [label.item_id,label]));
    return { schema_version: 'review-quality-dataset-v2', dataset_id: `b2b-${set.id}`, version: `${set.version}.0.0`,
      examples: items.map(item => {
        const label = byId.get(item.id)!;
        const issues = label.issues.map(issue => ({ category: issue.category, severity: issue.severity,
          evidence_quote: item.body!.slice(issue.start,issue.end),
          ...(issue.outside_topic ? { outside_topic: issue.outside_topic } : {}) }));
        return { id: `b2b-${item.id}`, synthetic: set.origin === 'synthetic_test',
          case_type: label.decision === 'problem' ? 'complaint' :
            label.decision === 'insufficient_evidence' ? 'ambiguous' : 'neutral',
          text: item.body, source: { kind: 'b2b_csv', name: 'B2B CSV', url: item.source_url,
            published_at: item.published_at?.toISOString().slice(0,10) ?? null,
            language: item.review_language, tenant_id: set.tenant_id, source_id: item.source_id,
            document_id: item.document_id, external_key: item.external_key },
          labeler: `human:${label.reviewer_id}`, rights_basis: item.rights_reference,
          gold: { decision: label.decision, issues } };
      }) };
  }

  private async evaluate(request: Request, id: string, paid: boolean, body?: unknown) {
    const principal = await this.accounts.principal(request, ['owner', 'admin']);
    const f = paid ? parse(paidInput, body) : null;
    const provider = paid ? 'openai' : 'test';
    const model = f?.model ?? 'controlled-test-fixture-v1';
    const settings = paid ? { provider, model, max_examples: f!.max_examples,
      max_output_tokens: f!.max_output_tokens, budget_usd: f!.budget_usd,
      input_usd_per_million: f!.input_usd_per_million,
      output_usd_per_million: f!.output_usd_per_million, allow_paid: true } :
      { provider, model, max_examples: 25, max_output_tokens: 512 };
    const prepared = await this.db.tenant(principal.tenantId, async client => {
      const set = await this.one(client,id,true);
      const dataset = await this.evaluationData(client,set,paid);
      if (paid && conservativeCost(dataset.examples.slice(0,f!.max_examples).map(item => item.text!),
        f!.max_output_tokens,f!.input_usd_per_million,f!.output_usd_per_million) > f!.budget_usd)
        throw new BadRequestException('Reserva estimada excede o orçamento informado; reduza lote ou saída');
      const existing = await this.db.rows<ReportRow>(client,
        'SELECT * FROM marketrift.b2b_quality_reports WHERE set_id=$1 AND provider=$2 AND model=$3', [id,provider,model]);
      const current = existing[0];
      if (current && current.status === 'failed' && provider === 'test') {
        await client.query(`UPDATE marketrift.b2b_quality_reports SET status='reserved',result=NULL,
          error_code=NULL,finished_at=NULL,created_by=$2 WHERE id=$1`, [current.id,principal.userId]);
        return { dataset, reportId: current.id };
      }
      if (current) throw new ConflictException(current.status === 'reserved'
        ? 'Avaliação desta versão e modelo já está em andamento'
        : current.status === 'failed' && paid
          ? 'Uma tentativa paga falhou; nova chamada exige revisão operacional para evitar cobrança duplicada'
          : 'Esta versão e modelo já têm relatório concluído');
      const [report] = await this.db.rows<{ id: string }>(client, `INSERT INTO marketrift.b2b_quality_reports
        (tenant_id,set_id,provider,model,status,created_by) VALUES ($1,$2,$3,$4,'reserved',$5) RETURNING id`,
      [principal.tenantId,id,provider,model,principal.userId]);
      if (!report) throw new ServiceUnavailableException('Falha ao reservar avaliação');
      return { dataset, reportId: report.id };
    });
    try {
      const result = await internalEvaluate(prepared.dataset, settings);
      if (result.report_schema_version !== 'review-quality-report-v2' ||
          (result.dataset as { id?: string } | undefined)?.id !== prepared.dataset.dataset_id ||
          (result.run as { provider?: string } | undefined)?.provider !== provider)
        throw new LocalEvaluatorError('report_contract_mismatch',
          'Relatório do FastAPI não corresponde a esta versão congelada; reinicie API e serviço HTTP atualizados');
      await this.db.tenant(principal.tenantId, client => client.query(`UPDATE marketrift.b2b_quality_reports
        SET status='completed',result=$2,finished_at=now() WHERE id=$1`, [prepared.reportId,JSON.stringify(result)]).then(() => undefined));
      return { id: prepared.reportId, result };
    } catch (error) {
      await this.db.tenant(principal.tenantId, client => client.query(`UPDATE marketrift.b2b_quality_reports
        SET status='failed',error_code=$2,finished_at=now() WHERE id=$1`,
      [prepared.reportId,error instanceof LocalEvaluatorError ? error.reason : 'evaluation_unavailable']).then(() => undefined));
      throw error;
    }
  }

  @Post('sets/:id/evaluate-test')
  evaluateTest(@Req() request: Request, @Param('id') id: string) { return this.evaluate(request,id,false); }
  @Post('sets/:id/evaluate-paid')
  evaluatePaid(@Req() request: Request, @Param('id') id: string, @Body() body: unknown) {
    return this.evaluate(request,id,true,body);
  }
}
