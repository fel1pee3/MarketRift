import { BadRequestException, Body, ConflictException, Controller, Get, Inject, NotFoundException, Param, Patch, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import type { PoolClient, QueryResultRow } from 'pg';
import { z } from 'zod';
import { Accounts, Principal } from './accounts';
import { Db } from './db';

const uuid = z.uuid();
const text = (min: number, max = 2000) => z.string().trim().min(min).max(max);
const httpsUrl = z.url().refine(value => new URL(value).protocol === 'https:', 'Use uma URL HTTPS');
const capabilityInput = z.object({ product_id: uuid, topic: text(2, 100), claim: text(10, 500),
  evidence_url: httpsUrl }).strict();
const hypothesisInput = z.object({ signal_id: uuid, hypothesis_kind: z.enum(['product', 'marketing']),
  interpretation: text(10), proposed_action: text(10), unverified_claims: text(5),
  verification_steps: text(10), risks: text(0).default(''), own_capability_id: uuid.optional(),
  own_advantage_claim: text(10, 500).optional() }).strict().refine(value =>
    Boolean(value.own_capability_id) === Boolean(value.own_advantage_claim),
  'Uma vantagem própria exige uma capacidade verificada e uma alegação explícita');
const reviewInput = z.object({ status: z.enum(['approved', 'rejected']), reason: text(3, 500) }).strict();

function input<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new BadRequestException(result.error.issues.map(issue => issue.message));
  return result.data;
}
type SignalRow = QueryResultRow & { id: string; source_id: string; state: string; fact_key: string; evidence_hash: string;
  rule_version: string; source_type: string; evidence: Record<string, unknown>; interpretation_limit: string;
  test_data: boolean; source_enabled: boolean };
type CapabilityRow = QueryResultRow & { id: string; product_id: string; topic: string; claim: string;
  evidence_url: string | null; verification_status: string; verified_at: Date | null; reviewed_by: string | null };
type HypothesisRow = QueryResultRow & { id: string; signal_id: string; status: string; signal_fact_key: string;
  signal_evidence_hash: string; signal_rule_version: string; own_capability_id: string | null;
  author_user_id: string | null; facts: Fact[]; source_type: string; coverage_note: string;
  signal_state: string; signal_test_data: boolean; signal_summary: string; signal_source_enabled: boolean };
type Fact = { evidence_id: string; observed_at: string; quote: string; url: string; kind: string };

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function field(value: unknown): string | null { return typeof value === 'string' && value.trim() ? value : null; }
function date(value: unknown): string | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) return new Date(value).toISOString();
  return null;
}
export function coverageNoteForSignal(sourceType: string, coverage: unknown): string {
  if (sourceType === 'github_issues' || sourceType === 'github_discussions')
    return `${sourceType === 'github_issues' ? 'Issues' : 'Discussions'} são atividade pública; autores não foram identificados como clientes. `
      + (coverage === 'partial_cursor' ? 'Coleta parcial por cursor; os documentos não representam todo o histórico.'
        : 'O total se refere aos documentos distintos armazenados, não ao mercado.');
  if (sourceType === 'pricing_page')
    return 'Duas capturas confirmadas e comparáveis mostram um preço listado; não comprovam oferta contratual ou impacto comercial.';
  return 'Uma entrada confirmada no changelog foi observada; não comprova adoção ou impacto comercial.';
}

export async function signalFactsForHypothesis(db: Db, client: PoolClient, signal: SignalRow): Promise<Fact[]> {
  if (signal.source_type === 'pricing_page' || signal.source_type === 'release_notes') {
    const parts = [record(signal.evidence.previous), record(signal.evidence.current)];
    const facts: Fact[] = [];
    for (const part of parts) {
      const id = field(part?.snapshot_id); const quote = field(part?.quote);
      const url = field(part?.url); const at = date(part?.at);
      if (!id || !quote || !url || !at) throw new ConflictException('O sinal não contém duas evidências de página completas');
      const snapshots = await db.rows<{ id: string }>(client, `SELECT id FROM marketrift.source_snapshots
        WHERE id=$1 AND content_sha256=$2 AND final_url=$3
          AND position($4 in regexp_replace(normalized_text, '\\s+', ' ', 'g')) > 0`,
      [id, part?.content_hash, url, quote.replace(/\s+/g, ' ')]);
      if (!snapshots[0]) throw new ConflictException('A captura do sinal não confirma o trecho literal atual');
      facts.push({ evidence_id: id, observed_at: at, quote, url, kind: signal.source_type });
    }
    return facts;
  }
  if (signal.source_type !== 'github_issues' && signal.source_type !== 'github_discussions')
    throw new ConflictException('Tipo de sinal sem evidência suportada');
  const examples = signal.evidence.examples;
  const sources = signal.evidence.source_ids;
  if (!Array.isArray(examples) || !Array.isArray(sources)) throw new ConflictException('Exemplos públicos ausentes');
  const facts: Fact[] = [];
  for (const example of examples.slice(0, 5)) {
    const value = record(example); const id = field(value?.document_id); const url = field(value?.url);
    if (!id || !url) throw new ConflictException('Referência de documento público incompleta');
    const documents = await db.rows<{ id: string; body: string; source_url: string; collected_at: Date;
      source_created_at: Date | null }>(client, `SELECT id,body,source_url,collected_at,source_created_at
        FROM marketrift.documents WHERE id=$1 AND source_id=ANY($2::uuid[])
          AND document_type=$3 AND NOT synthetic`,
    [id, sources, signal.source_type === 'github_issues' ? 'github_issue' : 'github_discussion']);
    const document = documents[0];
    if (!document || document.source_url !== url || !document.body.trim())
      throw new ConflictException('Documento de origem alterado ou indisponível; reconcilie o sinal');
    facts.push({ evidence_id: id, observed_at: (document.source_created_at ?? document.collected_at).toISOString(),
      quote: document.body.trim().slice(0, 240), url, kind: signal.source_type });
  }
  if (!facts.length) throw new ConflictException('Não há trecho literal para fundamentar a hipótese');
  return facts;
}

@Controller('v1/action-hypotheses')
export class ActionHypothesesController {
  constructor(@Inject(Db) private readonly db: Db, @Inject(Accounts) private readonly accounts: Accounts) {}

  private async approvedSignal(client: PoolClient, id: string): Promise<SignalRow> {
    const rows = await this.db.rows<SignalRow>(client, `SELECT r.id,r.source_id,r.state,r.fact_key,r.evidence_hash,
      r.rule_version,r.source_type,r.evidence,r.interpretation_limit,r.test_data,
      s.enabled AS source_enabled FROM marketrift.reviewable_signals r
      JOIN marketrift.sources s ON s.tenant_id=r.tenant_id AND s.id=r.source_id
      WHERE r.id=$1 FOR UPDATE OF r`, [id]);
    if (!rows[0] || rows[0].state !== 'approved' || !rows[0].source_enabled)
      throw new ConflictException('Escolha um sinal aprovado com fonte ativa nesta empresa');
    const sourceIds = Array.isArray(rows[0].evidence.source_ids) ? rows[0].evidence.source_ids : [];
    const pending = await this.db.rows<{ source_id: string }>(client, `SELECT source_id
      FROM marketrift.signal_reconcile_sources WHERE
      source_id=ANY($1::uuid[]) AND requested_revision>processed_revision LIMIT 1`,
    [sourceIds.length ? sourceIds : [rows[0].source_id]]);
    if (pending[0]) throw new ConflictException('A origem ainda aguarda reconciliação; atualize o sinal antes de propor');
    return rows[0];
  }

  private async verifiedCapability(client: PoolClient, id: string): Promise<CapabilityRow> {
    const rows = await this.db.rows<CapabilityRow>(client, `SELECT c.id,c.product_id,t.name AS topic,
      c.claim,c.evidence_url,c.verification_status,c.verified_at,c.reviewed_by
      FROM marketrift.product_capabilities c JOIN marketrift.products p
        ON p.tenant_id=c.tenant_id AND p.id=c.product_id
      JOIN marketrift.watch_topics t ON t.tenant_id=c.tenant_id AND t.id=c.topic_id
      WHERE c.id=$1 AND p.kind='own' FOR UPDATE OF c`, [id]);
    const value = rows[0];
    if (!value || value.verification_status !== 'verified' || !value.evidence_url || !value.verified_at)
      throw new ConflictException('A vantagem própria exige capacidade cadastrada e revisada com URL de evidência');
    return value;
  }

  @Get('capabilities')
  async capabilities(@Req() request: Request): Promise<CapabilityRow[]> {
    const principal = await this.accounts.principal(request);
    return this.db.tenant(principal.tenantId, client => this.db.rows<CapabilityRow>(client,
      `SELECT c.id,c.product_id,t.name AS topic,c.claim,c.evidence_url,c.verification_status,
        c.verified_at,c.reviewed_by FROM marketrift.product_capabilities c
        JOIN marketrift.products p ON p.tenant_id=c.tenant_id AND p.id=c.product_id
        JOIN marketrift.watch_topics t ON t.tenant_id=c.tenant_id AND t.id=c.topic_id
        WHERE p.kind='own' AND ($1::boolean=false OR c.verification_status='verified')
        ORDER BY c.verified_at DESC NULLS LAST,c.id LIMIT 100`, [principal.role === 'viewer']));
  }

  @Post('capabilities')
  async createCapability(@Req() request: Request, @Body() body: unknown): Promise<CapabilityRow> {
    const principal = await this.accounts.principal(request, ['owner', 'admin']);
    const data = input(capabilityInput, body);
    return this.db.tenant(principal.tenantId, async client => {
      const own = await this.db.rows<{ id: string }>(client,
        "SELECT id FROM marketrift.products WHERE id=$1 AND kind='own'", [data.product_id]);
      if (!own[0]) throw new NotFoundException('Produto próprio não encontrado nesta empresa');
      await client.query(`INSERT INTO marketrift.watch_topics (tenant_id,name) VALUES ($1,$2)
        ON CONFLICT (tenant_id,name) DO NOTHING`, [principal.tenantId, data.topic]);
      const rows = await this.db.rows<CapabilityRow>(client, `INSERT INTO marketrift.product_capabilities
        (tenant_id,product_id,topic_id,claim,evidence_url)
        SELECT $1,$2,id,$4,$5 FROM marketrift.watch_topics WHERE tenant_id=$1 AND name=$3
        ON CONFLICT (tenant_id,product_id,topic_id,claim) DO NOTHING
        RETURNING id,product_id,claim,evidence_url,verification_status,verified_at,reviewed_by`,
      [principal.tenantId, data.product_id, data.topic, data.claim, data.evidence_url]);
      if (!rows[0]) throw new ConflictException('Esta capacidade já está cadastrada');
      return { ...rows[0], topic: data.topic };
    });
  }

  @Post('capabilities/:id/verify')
  async verifyCapability(@Req() request: Request, @Param('id') value: string): Promise<CapabilityRow> {
    const principal = await this.accounts.principal(request, ['owner', 'admin']);
    const id = input(uuid, value);
    return this.db.tenant(principal.tenantId, async client => {
      const rows = await this.db.rows<CapabilityRow>(client, `UPDATE marketrift.product_capabilities c
        SET verification_status='verified',verified_at=now(),reviewed_by=$2
        FROM marketrift.products p WHERE c.id=$1 AND p.tenant_id=c.tenant_id
          AND p.id=c.product_id AND p.kind='own' AND c.verification_status='unverified'
          AND c.evidence_url IS NOT NULL
        RETURNING c.id,c.product_id,c.claim,c.evidence_url,c.verification_status,c.verified_at,c.reviewed_by`,
      [id, principal.userId]);
      if (!rows[0]) throw new ConflictException('Capacidade inexistente, já revisada ou sem evidência');
      return { ...rows[0], topic: '' };
    });
  }

  @Get()
  async list(@Req() request: Request): Promise<(HypothesisRow & { history: QueryResultRow[] })[]> {
    const principal = await this.accounts.principal(request);
    return this.db.tenant(principal.tenantId, async client => {
      const rows = await this.db.rows<HypothesisRow>(client, `SELECT h.*,
        r.state AS signal_state,r.test_data AS signal_test_data,r.summary AS signal_summary,
        s.enabled AS signal_source_enabled FROM marketrift.action_hypotheses h
        JOIN marketrift.reviewable_signals r ON r.tenant_id=h.tenant_id AND r.id=h.signal_id
        JOIN marketrift.sources s ON s.tenant_id=r.tenant_id AND s.id=r.source_id
        WHERE h.tenant_id=$1 AND ($2::boolean=false OR
          (h.status='approved' AND r.state='approved' AND s.enabled
           AND h.signal_fact_key=r.fact_key AND h.signal_rule_version=r.rule_version))
        ORDER BY h.created_at DESC,h.id LIMIT 100`, [principal.tenantId, principal.role === 'viewer']);
      if (!rows.length) return [];
      const events = await this.db.rows<QueryResultRow>(client, `SELECT hypothesis_id,actor_user_id,
        action,from_status,to_status,reason,occurred_at FROM marketrift.action_hypothesis_events
        WHERE tenant_id=$1 AND hypothesis_id=ANY($2::uuid[]) ORDER BY occurred_at,id`,
      [principal.tenantId, rows.map(row => row.id)]);
      return rows.map(row => ({ ...row, history: events.filter(event => event.hypothesis_id === row.id) }));
    });
  }

  @Post()
  async create(@Req() request: Request, @Body() body: unknown): Promise<{ id: string; status: string }> {
    const principal = await this.accounts.principal(request, ['owner', 'admin', 'analyst']);
    const data = input(hypothesisInput, body);
    return this.db.tenant(principal.tenantId, async client => {
      const signal = await this.approvedSignal(client, data.signal_id);
      if (data.own_capability_id) await this.verifiedCapability(client, data.own_capability_id);
      const facts = await signalFactsForHypothesis(this.db, client, signal);
      const coverage = coverageNoteForSignal(signal.source_type, signal.evidence.coverage);
      const rows = await this.db.rows<{ id: string; status: string }>(client, `INSERT INTO marketrift.action_hypotheses
        (tenant_id,signal_id,signal_fact_key,signal_evidence_hash,signal_rule_version,
         hypothesis_kind,facts,source_type,coverage_note,interpretation,proposed_action,
         unverified_claims,verification_steps,risks,own_capability_id,own_advantage_claim,author_user_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
        ON CONFLICT (tenant_id,signal_id,signal_fact_key) DO NOTHING RETURNING id,status`,
      [principal.tenantId, signal.id, signal.fact_key, signal.evidence_hash, signal.rule_version,
        data.hypothesis_kind, JSON.stringify(facts), signal.source_type, coverage,
        data.interpretation, data.proposed_action, data.unverified_claims, data.verification_steps,
        data.risks, data.own_capability_id ?? null, data.own_advantage_claim ?? null, principal.userId]);
      if (!rows[0]) throw new ConflictException('Já existe uma hipótese para esta versão do sinal');
      await client.query(`INSERT INTO marketrift.action_hypothesis_events
        (tenant_id,hypothesis_id,actor_user_id,action,to_status)
        VALUES ($1,$2,$3,'created','draft')`, [principal.tenantId, rows[0].id, principal.userId]);
      return rows[0];
    });
  }

  private async currentHypothesis(client: PoolClient, id: string): Promise<HypothesisRow> {
    const rows = await this.db.rows<HypothesisRow>(client, `SELECT h.* FROM marketrift.action_hypotheses h
      WHERE h.id=$1 FOR UPDATE`, [id]);
    if (!rows[0]) throw new NotFoundException('Hipótese não encontrada nesta empresa');
    return rows[0];
  }

  private async lockedSignalForHypothesis(client: PoolClient, id: string): Promise<SignalRow> {
    const rows = await this.db.rows<{ signal_id: string }>(client,
      'SELECT signal_id FROM marketrift.action_hypotheses WHERE id=$1', [id]);
    if (!rows[0]) throw new NotFoundException('Hipótese não encontrada nesta empresa');
    // Reconciliation locks the signal before its trigger locks hypotheses. Keep
    // the same order here so simultaneous approval and reconciliation cannot deadlock.
    return this.approvedSignal(client, rows[0].signal_id);
  }

  private async ensureCurrent(client: PoolClient, hypothesis: HypothesisRow, signal: SignalRow): Promise<void> {
    if (hypothesis.signal_fact_key !== signal.fact_key || hypothesis.signal_rule_version !== signal.rule_version)
      throw new ConflictException('A evidência do sinal mudou; revise a hipótese antes de aprovar');
    if (hypothesis.own_capability_id) await this.verifiedCapability(client, hypothesis.own_capability_id);
  }

  @Patch(':id')
  async edit(@Req() request: Request, @Param('id') value: string, @Body() body: unknown): Promise<{ status: string }> {
    const principal = await this.accounts.principal(request, ['owner', 'admin', 'analyst']);
    const id = input(uuid, value);
    const data = input(hypothesisInput, body);
    return this.db.tenant(principal.tenantId, async client => {
      const signal = await this.lockedSignalForHypothesis(client, id);
      const hypothesis = await this.currentHypothesis(client, id);
      if (hypothesis.status !== 'draft') throw new ConflictException('Somente um rascunho pode ser editado');
      if (data.signal_id !== hypothesis.signal_id)
        throw new ConflictException('A origem de uma hipótese não pode ser trocada');
      if (principal.role === 'analyst' && hypothesis.author_user_id !== principal.userId)
        throw new ConflictException('Analyst só pode editar o próprio rascunho');
      await this.ensureCurrent(client, hypothesis, signal);
      if (data.own_capability_id) await this.verifiedCapability(client, data.own_capability_id);
      await client.query(`UPDATE marketrift.action_hypotheses SET hypothesis_kind=$2,
        interpretation=$3,proposed_action=$4,unverified_claims=$5,verification_steps=$6,
        risks=$7,own_capability_id=$8,own_advantage_claim=$9,updated_at=now() WHERE id=$1`,
      [id, data.hypothesis_kind, data.interpretation, data.proposed_action, data.unverified_claims,
        data.verification_steps, data.risks, data.own_capability_id ?? null, data.own_advantage_claim ?? null]);
      return { status: 'draft' };
    });
  }

  @Post(':id/submit')
  async submit(@Req() request: Request, @Param('id') value: string): Promise<{ status: string }> {
    const principal = await this.accounts.principal(request, ['owner', 'admin', 'analyst']);
    const id = input(uuid, value);
    return this.db.tenant(principal.tenantId, async client => {
      const signal = await this.lockedSignalForHypothesis(client, id);
      const hypothesis = await this.currentHypothesis(client, id);
      if (hypothesis.status !== 'draft') throw new ConflictException('Somente um rascunho pode ser proposto');
      if (principal.role === 'analyst' && hypothesis.author_user_id !== principal.userId)
        throw new ConflictException('Analyst só pode propor o próprio rascunho');
      await this.ensureCurrent(client, hypothesis, signal);
      await client.query(`UPDATE marketrift.action_hypotheses SET status='proposed',submitted_at=now(),
        updated_at=now() WHERE id=$1`, [id]);
      await client.query(`INSERT INTO marketrift.action_hypothesis_events
        (tenant_id,hypothesis_id,actor_user_id,action,from_status,to_status)
        VALUES ($1,$2,$3,'submitted','draft','proposed')`, [principal.tenantId, id, principal.userId]);
      return { status: 'proposed' };
    });
  }

  @Post(':id/review')
  async review(@Req() request: Request, @Param('id') value: string, @Body() body: unknown):
    Promise<{ status: string }> {
    const principal: Principal = await this.accounts.principal(request, ['owner', 'admin']);
    const id = input(uuid, value); const data = input(reviewInput, body);
    return this.db.tenant(principal.tenantId, async client => {
      const signal = data.status === 'approved' ? await this.lockedSignalForHypothesis(client, id) : null;
      const hypothesis = await this.currentHypothesis(client, id);
      if (hypothesis.status !== 'proposed') throw new ConflictException('Somente uma proposta pendente pode ser revisada');
      if (signal) await this.ensureCurrent(client, hypothesis, signal);
      await client.query(`UPDATE marketrift.action_hypotheses SET status=$2,reviewer_user_id=$3,
        review_reason=$4,reviewed_at=now(),updated_at=now() WHERE id=$1`,
      [id, data.status, principal.userId, data.reason]);
      await client.query(`INSERT INTO marketrift.action_hypothesis_events
        (tenant_id,hypothesis_id,actor_user_id,action,from_status,to_status,reason)
        VALUES ($1,$2,$3,$4,'proposed',$4,$5)`,
      [principal.tenantId, id, principal.userId, data.status, data.reason]);
      return { status: data.status };
    });
  }
}
