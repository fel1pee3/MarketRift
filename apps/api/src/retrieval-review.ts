import { BadRequestException, Body, ConflictException, Controller, Get, Inject, Param, Post, Query, Req, ServiceUnavailableException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Request } from 'express';
import type { PoolClient, QueryResultRow } from 'pg';
import { z } from 'zod';
import { Accounts } from './accounts';
import { Db } from './db';

const uuid = z.uuid();
const createSchema = z.object({ title: z.string().trim().min(3).max(120), product_id: uuid.optional(),
  from: z.iso.date().optional(), to: z.iso.date().optional(), limit: z.number().int().min(1).max(30).default(20),
  test_only: z.boolean().default(false) })
  .strict().refine(value => !value.from || !value.to || value.from <= value.to);
const questionSchema = z.object({ text: z.string().trim().min(3).max(500), language: z.enum(['pt', 'en']) }).strict();
const judgmentSchema = z.object({ item_id: uuid, verdict: z.enum(['relevant', 'irrelevant']) }).strict();
const claimSchema = z.object({ no_answer: z.boolean() }).strict();
const freezeSchema = z.object({ acknowledge_unjudged: z.boolean().default(false) }).strict();
const localModel = 'sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2';
const localRevision = 'e8f8c211226b894fcb81acc59f3b34ba3efd5f42';
const indexVersion = 'evidence_chunks/013/exact-cosine/chunks-v1';
export const frozenEvaluatorVersion = 'frozen-ranking-v2';
export const frozenContractVersion = 'frozen-eval-contract-v2';

type SetRow = QueryResultRow & { id: string; tenant_id: string; title: string; origin: 'public_real' | 'synthetic_test'; status: 'draft' | 'frozen';
  version: number; product_id: string | null; corpus_hash: string | null; created_at: Date; frozen_at: Date | null };
type ItemRow = QueryResultRow & { id: string; document_id: string; chunk_id: string; source_id: string;
  source_type: 'github_issue' | 'github_discussion'; origin_key: string; source_url: string; observed_at: Date;
  text_content: string; text_hash: string; content_version: string; chunk_no: number; source_partial: boolean;
  stale?: boolean };
type QuestionRow = QueryResultRow & { id: string; text_content: string; language: 'pt' | 'en';
  no_answer_claim: boolean; created_at: Date };
type JudgmentRow = QueryResultRow & { question_id: string; item_id: string; verdict: 'relevant' | 'irrelevant';
  reviewer_id: string; revision: number; judged_at: Date };
type ReportRow = QueryResultRow & { id: string; set_id: string; corpus_hash: string; judgment_hash: string;
  result: Record<string, unknown>; created_at: Date };

type FrozenDatasetIdentity = { set_id: string; version: string; origin: 'real' | 'synthetic'; index_version: string;
  corpus_hash: string; judgment_hash: string; documents: { id: string }[];
  questions: { id: string; judged_ids: string[]; relevant_ids: string[] }[] };

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function sameOrderedIds(value: unknown, expected: string[]): boolean {
  return Array.isArray(value) && value.length === expected.length &&
    value.every((id, index) => typeof id === 'string' && id === expected[index]);
}

export function reportMismatchField(value: unknown, dataset: FrozenDatasetIdentity): string | null {
  const result = object(value);
  if (!result) return 'result';
  const fields: [string, unknown, unknown][] = [
    ['contract_version', result.contract_version, frozenContractVersion],
    ['evaluator_version', result.evaluator_version, frozenEvaluatorVersion],
    ['set_id', result.set_id, dataset.set_id],
    ['dataset_version', result.dataset_version, dataset.version],
    ['origin', result.origin, dataset.origin === 'real' ? 'public_github_real' : 'synthetic_test'],
    ['index_version', result.index_version, dataset.index_version],
    ['corpus_hash', result.corpus_hash, dataset.corpus_hash],
    ['judgment_hash', result.judgment_hash, dataset.judgment_hash],
    ['corpus_size', result.corpus_size, dataset.documents.length],
    ['question_count', result.question_count, dataset.questions.length],
  ];
  for (const [field, actual, expected] of fields) if (actual !== expected) return field;
  if (!sameOrderedIds(result.document_ids, dataset.documents.map(item => item.id))) return 'document_ids';
  if (!sameOrderedIds(result.question_ids, dataset.questions.map(item => item.id))) return 'question_ids';
  const labels = object(result.labels_by_question);
  if (!labels || Object.keys(labels).sort().join(',') !== dataset.questions.map(item => item.id).sort().join(','))
    return 'labels_by_question';
  for (const question of dataset.questions) {
    const entry = object(labels[question.id]);
    if (!entry || !sameOrderedIds(entry.judged_ids, question.judged_ids))
      return `labels_by_question.${question.id}.judged_ids`;
    if (!sameOrderedIds(entry.relevant_ids, question.relevant_ids))
      return `labels_by_question.${question.id}.relevant_ids`;
  }
  const runs = object(result.runs);
  const modes = dataset.origin === 'real' ? ['local', 'controlled', 'literal'] : ['controlled', 'literal'];
  if (!runs || Object.keys(runs).sort().join(',') !== modes.sort().join(',')) return 'runs';
  const eligible = new Set(dataset.documents.map(item => item.id));
  const questions = dataset.questions.map(item => item.id);
  for (const mode of modes) {
    const run = object(runs[mode]);
    const rankedIds = object(run?.ranked_ids);
    const coverage = object(run?.ranking_coverage);
    if (!rankedIds || Object.keys(rankedIds).sort().join(',') !== [...questions].sort().join(','))
      return `runs.${mode}.ranked_ids`;
    if (!coverage || Object.keys(coverage).sort().join(',') !== [...questions].sort().join(','))
      return `runs.${mode}.ranking_coverage`;
    for (const id of questions) {
      const top = rankedIds[id];
      const entry = object(coverage[id]);
      const exclusions = entry?.excluded;
      if (!entry || !Array.isArray(exclusions) || entry.eligible_count !== eligible.size ||
        typeof entry.ranked_count !== 'number' ||
        !Number.isInteger(entry.ranked_count) || entry.ranked_count < 0 || entry.ranked_count > eligible.size ||
        exclusions.length !== eligible.size - entry.ranked_count)
        return `runs.${mode}.ranking_coverage.${id}`;
      if (!Array.isArray(top) || top.length !== Math.min(5, entry.ranked_count) ||
        new Set(top).size !== top.length || top.some(item => typeof item !== 'string' || !eligible.has(item)))
        return `runs.${mode}.ranked_ids.${id}`;
      const omitted = exclusions.map(item => object(item));
      if (omitted.some(item => !item || typeof item.item_id !== 'string' || !eligible.has(item.item_id) ||
        top.includes(item.item_id) || typeof item.reason !== 'string' || !item.reason.trim()) ||
        new Set(omitted.map(item => item?.item_id)).size !== omitted.length)
        return `runs.${mode}.ranking_coverage.${id}.excluded`;
    }
  }
  return null;
}

export function reportMatchesDataset(value: unknown, dataset: FrozenDatasetIdentity): boolean {
  return reportMismatchField(value, dataset) === null;
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new BadRequestException(result.error.issues.map(issue => issue.message));
  return result.data;
}
function hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }

// The order is stable and independent of later document edits or another product association.
export function corpusHash(items: ItemRow[]): string {
  return hash(items.map(item => [item.id, item.chunk_id, item.text_hash, item.content_version]
    ).sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
}
export function judgmentHash(questions: QuestionRow[], judgments: JudgmentRow[]): string {
  return hash({ questions: questions.map(q => [q.id, q.text_content, q.language, q.no_answer_claim])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  judgments: judgments.map(j => [j.question_id, j.item_id, j.verdict, j.reviewer_id, j.revision])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])) || String(a[1]).localeCompare(String(b[1]))) });
}

export function judgmentCoverage(items: ItemRow[], questions: QuestionRow[], judgments: JudgmentRow[]) {
  const total = items.length * questions.length;
  const complete = questions.filter(q => judgments.filter(j => j.question_id === q.id).length === items.length).length;
  return { judged: judgments.length, total, complete_questions: complete,
    unjudged: total - judgments.length, fully_judged: total > 0 && judgments.length === total };
}

@Controller('v1/retrieval-review')
export class RetrievalReviewController {
  constructor(@Inject(Db) private readonly db: Db, @Inject(Accounts) private readonly accounts: Accounts) {}

  private async rows(client: PoolClient, setId: string) {
    const items = await this.db.rows<ItemRow>(client,
      'SELECT * FROM marketrift.retrieval_items WHERE set_id = $1 ORDER BY source_type, origin_key, chunk_no, id', [setId]);
    const questions = await this.db.rows<QuestionRow>(client,
      'SELECT * FROM marketrift.retrieval_questions WHERE set_id = $1 ORDER BY created_at, id', [setId]);
    const judgments = await this.db.rows<JudgmentRow>(client,
      'SELECT * FROM marketrift.retrieval_judgments WHERE set_id = $1 ORDER BY question_id, item_id', [setId]);
    return { items, questions, judgments };
  }

  private async one(client: PoolClient, id: string, lock = false): Promise<SetRow> {
    const [set] = await this.db.rows<SetRow>(client,
      `SELECT * FROM marketrift.retrieval_sets WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id]);
    if (!set) throw new BadRequestException('Conjunto inexistente na empresa ativa');
    return set;
  }

  private async draft(client: PoolClient, id: string): Promise<SetRow> {
    const set = await this.one(client, id, true);
    if (set.status !== 'draft') throw new BadRequestException('Versão congelada; crie uma cópia para novos julgamentos');
    return set;
  }

  private async staleItems(client: PoolClient, set: SetRow): Promise<string[]> {
    const model = set.origin === 'synthetic_test' ? 'controlled-hash-TESTE' : localModel;
    const revision = set.origin === 'synthetic_test' ? '1' : localRevision;
    const rows = await this.db.rows<{ id: string }>(client, `SELECT i.id FROM marketrift.retrieval_items i
      LEFT JOIN marketrift.documents d ON d.tenant_id = i.tenant_id AND d.id = i.document_id
      LEFT JOIN marketrift.sources s ON s.tenant_id = i.tenant_id AND s.id = i.source_id
      LEFT JOIN marketrift.evidence_chunks e ON e.tenant_id = i.tenant_id AND e.id = i.chunk_id
      WHERE i.set_id = $1 AND (d.id IS NULL OR s.id IS NULL OR NOT s.enabled OR
        d.source_id <> i.source_id OR d.document_type <> i.source_type OR
        md5(d.body) <> i.content_version OR e.id IS NULL OR e.status <> 'ready' OR
        e.embedding_model <> $2 OR e.embedding_version <> $3 OR
        e.text_content <> i.text_content OR e.content_sha256 <> i.text_hash)`,
    [set.id, model, revision]);
    return rows.map(row => row.id);
  }

  @Get('sets')
  async list(@Req() request: Request) {
    const principal = await this.accounts.principal(request);
    return this.db.tenant(principal.tenantId, client => this.db.rows<SetRow>(client,
      'SELECT * FROM marketrift.retrieval_sets ORDER BY created_at DESC, id DESC LIMIT 50'));
  }

  @Post('sets')
  async create(@Req() request: Request, @Body() body: unknown) {
    const principal = await this.accounts.principal(request, ['owner', 'admin', 'analyst']);
    const f = parse(createSchema, body);
    if (f.test_only && (process.env.RETRIEVAL_REVIEW_TEST_MODE !== '1' || process.env.NODE_ENV === 'production'))
      throw new BadRequestException('Conjunto de teste desativado');
    const model = f.test_only ? 'controlled-hash-TESTE' : localModel;
    const revision = f.test_only ? '1' : localRevision;
    return this.db.tenant(principal.tenantId, async client => {
      if (f.product_id && !(await this.db.rows(client, 'SELECT id FROM marketrift.products WHERE id = $1', [f.product_id])).length)
        throw new BadRequestException('Produto inexistente na empresa ativa');
      const [set] = await this.db.rows<SetRow>(client, `INSERT INTO marketrift.retrieval_sets
        (tenant_id, title, origin, product_id, period_from, period_to, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [principal.tenantId, f.title, f.test_only ? 'synthetic_test' : 'public_real',
        f.product_id ?? null, f.from ?? null, f.to ?? null, principal.userId]);
      const sampled = await this.db.rows<ItemRow>(client, `WITH eligible AS (
        SELECT e.id AS chunk_id, d.id AS document_id, s.id AS source_id, s.product_id,
          d.document_type AS source_type, jsonb_build_array(coalesce(d.source_repository, s.url), d.external_key)::text AS origin_key,
          d.source_url, coalesce(d.published_at, d.source_created_at, d.collected_at) AS observed_at,
          e.text_content, e.content_sha256 AS text_hash, e.content_version, e.chunk_no,
          coalesce((SELECT NOT r.scan_complete FROM marketrift.source_runs r
            WHERE r.source_id = s.id AND r.status = 'succeeded' ORDER BY r.finished_at DESC NULLS LAST, r.id DESC LIMIT 1), true) AS source_partial,
          row_number() OVER (PARTITION BY d.document_type, coalesce(d.source_repository, s.url), d.external_key, e.chunk_no
            ORDER BY d.collected_at DESC, e.id) AS duplicate_rank
        FROM marketrift.evidence_chunks e
        JOIN marketrift.documents d ON d.tenant_id = e.tenant_id AND d.id = e.document_id
        JOIN marketrift.sources s ON s.tenant_id = d.tenant_id AND s.id = d.source_id
        WHERE s.enabled AND s.product_id = e.product_id AND e.source_id = s.id
          AND e.status = 'ready' AND e.embedding_model = $1 AND e.embedding_version = $2
          AND e.content_version = md5(d.body) AND strpos(d.body, e.text_content) > 0
          AND d.document_type IN ('github_issue', 'github_discussion')
          AND s.source_type IN ('github_issues', 'github_discussions')
          AND ((d.document_type = 'github_issue' AND s.source_type = 'github_issues') OR
               (d.document_type = 'github_discussion' AND s.source_type = 'github_discussions'))
          AND NOT d.synthetic AND NOT e.synthetic AND d.source_url LIKE 'https://github.com/%'
          AND ($3::uuid IS NULL OR s.product_id = $3)
          AND ($4::date IS NULL OR coalesce(d.published_at, d.source_created_at, d.collected_at) >= $4::date)
          AND ($5::date IS NULL OR coalesce(d.published_at, d.source_created_at, d.collected_at) < $5::date + interval '1 day')
      ) SELECT * FROM eligible WHERE duplicate_rank = 1 ORDER BY chunk_no, observed_at DESC, chunk_id LIMIT $6`,
      [model, revision, f.product_id ?? null, f.from ?? null, f.to ?? null, f.limit]);
      if (!sampled.length) throw new BadRequestException('Sem trechos públicos GitHub indexados para o MiniLM neste filtro');
      for (const item of sampled) await client.query(`INSERT INTO marketrift.retrieval_items
        (tenant_id,set_id,document_id,chunk_id,source_id,product_id,source_type,origin_key,source_url,
         observed_at,text_content,text_hash,content_version,chunk_no,source_partial)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [principal.tenantId, set!.id, item.document_id, item.chunk_id, item.source_id, item.product_id,
        item.source_type, item.origin_key, item.source_url, item.observed_at, item.text_content,
        item.text_hash, item.content_version, item.chunk_no, item.source_partial]);
      return { id: set!.id, items: sampled.length,
        partial_sources: new Set(sampled.filter(item => item.source_partial).map(item => item.source_id)).size };
    });
  }

  @Get('sets/:id')
  async detail(@Req() request: Request, @Param('id') id: string) {
    const principal = await this.accounts.principal(request);
    parse(uuid, id);
    return this.db.tenant(principal.tenantId, async client => {
      const set = await this.one(client, id);
      const { items, questions, judgments } = await this.rows(client, id);
      const stale = new Set(await this.staleItems(client, set));
      const reports = await this.db.rows<ReportRow>(client, `SELECT id, set_id, corpus_hash, judgment_hash, result, created_at
        FROM marketrift.retrieval_reports WHERE set_id = $1 ORDER BY created_at DESC LIMIT 10`, [id]);
      return { set, items: items.map(item => ({ ...item, stale: stale.has(item.id) })), questions, judgments,
        coverage: judgmentCoverage(items, questions, judgments), stale_items: stale.size,
        reports: reports.map(report => ({ ...report, stale: stale.size > 0 || report.corpus_hash !== corpusHash(items) ||
          report.judgment_hash !== judgmentHash(questions, judgments),
        obsolete: report.set_id !== set.id || report.result.evaluator_version !== frozenEvaluatorVersion ||
          report.result.dataset_version !== `public-github.v${set.version}` ||
          report.result.corpus_hash !== report.corpus_hash || report.result.judgment_hash !== report.judgment_hash })) };
    });
  }

  @Post('sets/:id/questions')
  async addQuestion(@Req() request: Request, @Param('id') id: string, @Body() body: unknown) {
    const principal = await this.accounts.principal(request, ['owner', 'admin', 'analyst']);
    parse(uuid, id); const f = parse(questionSchema, body);
    return this.db.tenant(principal.tenantId, async client => {
      await this.draft(client, id);
      const count = await this.db.rows<{ count: number }>(client,
        'SELECT count(*)::integer AS count FROM marketrift.retrieval_questions WHERE set_id = $1', [id]);
      if (count[0]!.count >= 20) throw new BadRequestException('Limite de 20 perguntas por conjunto');
      const [question] = await this.db.rows<QuestionRow>(client, `INSERT INTO marketrift.retrieval_questions
        (tenant_id,set_id,text_content,language,created_by) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [principal.tenantId, id, f.text, f.language, principal.userId]);
      return question;
    });
  }

  @Post('sets/:id/questions/:questionId/no-answer')
  async claimNoAnswer(@Req() request: Request, @Param('id') id: string,
    @Param('questionId') questionId: string, @Body() body: unknown) {
    const principal = await this.accounts.principal(request, ['owner', 'admin', 'analyst']);
    parse(uuid, id); parse(uuid, questionId); const f = parse(claimSchema, body);
    return this.db.tenant(principal.tenantId, async client => {
      await this.draft(client, id);
      if (f.no_answer && (await this.db.rows(client, `SELECT 1 FROM marketrift.retrieval_judgments
        WHERE set_id = $1 AND question_id = $2 AND verdict = 'relevant' LIMIT 1`, [id, questionId])).length)
        throw new BadRequestException('Há evidência marcada relevante; revise os julgamentos');
      const rows = await this.db.rows<QuestionRow>(client, `UPDATE marketrift.retrieval_questions
        SET no_answer_claim = $3 WHERE set_id = $1 AND id = $2 RETURNING *`, [id, questionId, f.no_answer]);
      if (!rows[0]) throw new BadRequestException('Pergunta inexistente');
      return rows[0];
    });
  }

  @Post('sets/:id/questions/:questionId/judgments')
  async judge(@Req() request: Request, @Param('id') id: string,
    @Param('questionId') questionId: string, @Body() body: unknown) {
    const principal = await this.accounts.principal(request, ['owner', 'admin', 'analyst']);
    parse(uuid, id); parse(uuid, questionId); const f = parse(judgmentSchema, body);
    return this.db.tenant(principal.tenantId, async client => {
      await this.draft(client, id);
      const [question] = await this.db.rows<QuestionRow>(client,
        'SELECT * FROM marketrift.retrieval_questions WHERE set_id = $1 AND id = $2', [id, questionId]);
      const [item] = await this.db.rows<ItemRow>(client,
        'SELECT * FROM marketrift.retrieval_items WHERE set_id = $1 AND id = $2', [id, f.item_id]);
      if (!question || !item) throw new BadRequestException('Pergunta ou evidência fora deste conjunto');
      if (question.no_answer_claim && f.verdict === 'relevant')
        throw new BadRequestException('Desmarque sem resposta antes de julgar relevante');
      const [judgment] = await this.db.rows<JudgmentRow>(client, `INSERT INTO marketrift.retrieval_judgments
        (tenant_id,set_id,question_id,item_id,verdict,reviewer_id) VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT (tenant_id,question_id,item_id) DO UPDATE SET verdict = EXCLUDED.verdict,
          reviewer_id = EXCLUDED.reviewer_id, revision = marketrift.retrieval_judgments.revision + 1,
          judged_at = now() RETURNING *`,
      [principal.tenantId, id, questionId, f.item_id, f.verdict, principal.userId]);
      return judgment;
    });
  }

  @Post('sets/:id/freeze')
  async freeze(@Req() request: Request, @Param('id') id: string, @Body() body: unknown) {
    const principal = await this.accounts.principal(request, ['owner', 'admin', 'analyst']);
    parse(uuid, id); const f = parse(freezeSchema, body);
    return this.db.tenant(principal.tenantId, async client => {
      await this.draft(client, id);
      const { items, questions, judgments } = await this.rows(client, id);
      if (!items.length || !questions.length) throw new BadRequestException('Adicione corpus e pergunta antes de congelar');
      const coverage = judgmentCoverage(items, questions, judgments);
      if (coverage.unjudged && !f.acknowledge_unjudged)
        throw new BadRequestException(`Revise ${coverage.unjudged} itens não julgados ou confirme cobertura incompleta`);
      for (const q of questions) {
        const judged = judgments.filter(j => j.question_id === q.id);
        if (judged.length === items.length && !judged.some(j => j.verdict === 'relevant') && !q.no_answer_claim)
          throw new BadRequestException('Marque explicitamente perguntas sem resposta no corpus');
      }
      const digest = corpusHash(items);
      await client.query(`UPDATE marketrift.retrieval_sets SET status = 'frozen', corpus_hash = $2,
        frozen_at = now() WHERE id = $1`, [id, digest]);
      return { status: 'frozen', corpus_hash: digest, coverage };
    });
  }

  @Post('sets/:id/fork')
  async fork(@Req() request: Request, @Param('id') id: string) {
    const principal = await this.accounts.principal(request, ['owner', 'admin', 'analyst']);
    parse(uuid, id);
    return this.db.tenant(principal.tenantId, async client => {
      const old = await this.one(client, id, true);
      if (old.status !== 'frozen') throw new BadRequestException('Congele a versão anterior antes de copiar');
      const [next] = await this.db.rows<SetRow>(client, `INSERT INTO marketrift.retrieval_sets
        (tenant_id,title,origin,product_id,period_from,period_to,version,parent_set_id,created_by)
        SELECT tenant_id,title,origin,product_id,period_from,period_to,version+1,id,$2
        FROM marketrift.retrieval_sets WHERE id=$1 RETURNING *`, [id, principal.userId]);
      const { items, questions, judgments } = await this.rows(client, id);
      const itemIds = new Map<string, string>(); const questionIds = new Map<string, string>();
      for (const item of items) {
        const [copy] = await this.db.rows<{ id: string }>(client, `INSERT INTO marketrift.retrieval_items
          (tenant_id,set_id,document_id,chunk_id,source_id,product_id,source_type,origin_key,source_url,
           observed_at,text_content,text_hash,content_version,chunk_no,source_partial)
          SELECT tenant_id,$2,document_id,chunk_id,source_id,product_id,source_type,origin_key,source_url,
           observed_at,text_content,text_hash,content_version,chunk_no,source_partial
          FROM marketrift.retrieval_items WHERE id=$1 RETURNING id`, [item.id, next!.id]);
        itemIds.set(item.id, copy!.id);
      }
      for (const q of questions) {
        const [copy] = await this.db.rows<{ id: string }>(client, `INSERT INTO marketrift.retrieval_questions
          (tenant_id,set_id,text_content,language,no_answer_claim,created_by)
          SELECT tenant_id,$2,text_content,language,no_answer_claim,$3
          FROM marketrift.retrieval_questions WHERE id=$1 RETURNING id`, [q.id, next!.id, principal.userId]);
        questionIds.set(q.id, copy!.id);
      }
      for (const j of judgments) await client.query(`INSERT INTO marketrift.retrieval_judgments
        (tenant_id,set_id,question_id,item_id,verdict,reviewer_id,revision,judged_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [principal.tenantId, next!.id,
        questionIds.get(j.question_id), itemIds.get(j.item_id), j.verdict, j.reviewer_id, j.revision, j.judged_at]);
      return { id: next!.id, version: next!.version };
    });
  }

  @Post('sets/:id/evaluate')
  async evaluate(@Req() request: Request, @Param('id') id: string) {
    const principal = await this.accounts.principal(request, ['owner', 'admin', 'analyst']);
    parse(uuid, id);
    if (process.env.EMBEDDING_PROVIDER !== 'local' &&
      !(process.env.RETRIEVAL_REVIEW_TEST_MODE === '1' && process.env.NODE_ENV !== 'production' &&
        process.env.EMBEDDING_PROVIDER === 'controlled'))
      throw new ServiceUnavailableException('Configure EMBEDDING_PROVIDER=local para avaliar o MiniLM');
    const dataset = await this.db.tenant(principal.tenantId, async client => {
      const set = await this.one(client, id);
      if (set.status !== 'frozen') throw new BadRequestException('Congele corpus e julgamentos antes da avaliação');
      if ((await this.staleItems(client, set)).length)
        throw new BadRequestException('A origem mudou ou foi removida; crie um novo conjunto antes de avaliar');
      if (set.origin === 'public_real' && process.env.EMBEDDING_PROVIDER !== 'local')
        throw new ServiceUnavailableException('MiniLM local obrigatório para conjunto público real');
      if (set.origin !== 'public_real' &&
        !(set.origin === 'synthetic_test' && process.env.RETRIEVAL_REVIEW_TEST_MODE === '1' &&
          process.env.NODE_ENV !== 'production'))
        throw new BadRequestException('Conjunto sintético requer modo de teste');
      const { items, questions, judgments } = await this.rows(client, id);
      if (set.corpus_hash !== corpusHash(items))
        throw new ConflictException('CONJUNTO_CONGELADO_DIVERGENTE: corpus_hash; crie outra versão após revisar a origem');
      return { set_id: set.id, version: `public-github.v${set.version}`,
        origin: set.origin === 'synthetic_test' ? 'synthetic' as const : 'real' as const,
        index_version: indexVersion,
        corpus_hash: set.corpus_hash!, judgment_hash: judgmentHash(questions, judgments),
        documents: items.map(item => ({ id: item.id, text: item.text_content, source_type: item.source_type })),
        questions: questions.map(q => ({ id: q.id, text: q.text_content, language: q.language,
          no_answer_claim: q.no_answer_claim,
          relevant_ids: judgments.filter(j => j.question_id === q.id && j.verdict === 'relevant').map(j => j.item_id),
          judged_ids: judgments.filter(j => j.question_id === q.id).map(j => j.item_id) })) };
    });
    const base = process.env.EMBEDDING_INTERNAL_URL ?? 'http://127.0.0.1:8000';
    const token = process.env.EMBEDDING_INTERNAL_TOKEN;
    if (!/^http:\/\/(127\.0\.0\.1|localhost):\d{2,5}$/.test(base) || !token)
      throw new ServiceUnavailableException('Serviço local de embeddings indisponível');
    let serviceStatus: Record<string, unknown>;
    try {
      const response = await fetch(`${base}/internal/embeddings/status`, {
        headers: { 'X-Internal-Token': token }, signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw new Error('internal_status_failed');
      serviceStatus = await response.json() as Record<string, unknown>;
    } catch { throw new ServiceUnavailableException('Serviço local de embeddings indisponível; confira FastAPI e o token interno'); }
    if (serviceStatus.retrieval_contract_version !== frozenContractVersion)
      throw new ConflictException('AVALIADOR_LOCAL_DESATUALIZADO: campo retrieval_contract_version; reinicie FastAPI e API');
    if (serviceStatus.retrieval_evaluator_version !== frozenEvaluatorVersion)
      throw new ConflictException('AVALIADOR_LOCAL_DESATUALIZADO: campo retrieval_evaluator_version; reinicie FastAPI e API');
    const expectedModel = dataset.origin === 'real' ? localModel : 'controlled-hash-TESTE';
    const expectedRevision = dataset.origin === 'real' ? localRevision : '1';
    if (serviceStatus.model !== expectedModel || serviceStatus.version !== expectedRevision)
      throw new ConflictException('MODELO_LOCAL_DIVERGENTE: confira EMBEDDING_PROVIDER e a revisão fixa do modelo');
    let result: Record<string, unknown>;
    try {
      const response = await fetch(`${base}/internal/retrieval/evaluate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Internal-Token': token },
        body: JSON.stringify(dataset), signal: AbortSignal.timeout(180000),
      });
      if (!response.ok) throw new Error('internal_evaluation_failed');
      result = await response.json() as Record<string, unknown>;
    } catch { throw new ServiceUnavailableException('A avaliação local falhou; confira o serviço FastAPI e o modelo'); }
    const mismatch = reportMismatchField(result, dataset);
    if (mismatch)
      throw new ConflictException(`CONTRATO_DE_AVALIACAO_DIVERGENTE: campo ${mismatch}; reinicie API e FastAPI. Se persistir, revise a versão congelada`);
    return this.db.tenant(principal.tenantId, async client => {
      const set = await this.one(client, id, true);
      const { items, questions, judgments } = await this.rows(client, id);
      if (set.status !== 'frozen') throw new ConflictException('CONJUNTO_CONGELADO_DIVERGENTE: status');
      if (set.corpus_hash !== dataset.corpus_hash || corpusHash(items) !== dataset.corpus_hash)
        throw new ConflictException('CONJUNTO_CONGELADO_DIVERGENTE: corpus_hash');
      if (judgmentHash(questions, judgments) !== dataset.judgment_hash)
        throw new ConflictException('CONJUNTO_CONGELADO_DIVERGENTE: judgment_hash');
      if (items.length !== dataset.documents.length || items.some((item, index) => item.id !== dataset.documents[index]?.id))
        throw new ConflictException('CONJUNTO_CONGELADO_DIVERGENTE: document_ids');
      if (questions.length !== dataset.questions.length ||
        questions.some((question, index) => question.id !== dataset.questions[index]?.id))
        throw new ConflictException('CONJUNTO_CONGELADO_DIVERGENTE: question_ids');
      const [report] = await this.db.rows<{ id: string }>(client, `INSERT INTO marketrift.retrieval_reports
        (tenant_id,set_id,corpus_hash,judgment_hash,result,created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [principal.tenantId, id, dataset.corpus_hash, dataset.judgment_hash, result, principal.userId]);
      return { id: report!.id, result };
    });
  }
}
