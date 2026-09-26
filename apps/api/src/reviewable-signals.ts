import { BadRequestException, Body, ConflictException, Controller, Get, Inject, NotFoundException, Param, Post, Req } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Request } from 'express';
import type { PoolClient, QueryResultRow } from 'pg';
import { z } from 'zod';
import { Accounts } from './accounts';
import { Db } from './db';

export const signalRuleVersion = 'observed-facts-v1';
const uuid = z.uuid();
const decision = z.object({ state: z.enum(['approved', 'discarded']), reason: z.string().trim().min(3).max(500) }).strict();
const readInput = z.object({ read: z.boolean() }).strict();
type SignalType = 'price_change' | 'release_entry' | 'github_issue_activity' | 'github_discussion_activity';
type Fact = { key: string; type: SignalType; sourceType: string; sourceId: string; pageChangeId: string | null;
  previousSnapshotId: string | null; currentSnapshotId: string | null; summary: string; limit: string;
  evidence: Record<string, unknown>; observedAt: Date; testData: boolean };
type PageRow = QueryResultRow & { id: string; source_id: string; product_id: string; source_type: 'pricing_page' | 'release_notes';
  source_url: string; previous_snapshot_id: string; current_snapshot_id: string; change_details: unknown[];
  previous_url: string; current_url: string; previous_hash: string; current_hash: string;
  previous_text: string; current_text: string; previous_extracted: Record<string, unknown>;
  current_extracted: Record<string, unknown>; previous_at: Date; current_at: Date; detected_at: Date };
type PublicRow = QueryResultRow & { id: string; product_id: string; source_type: 'github_issues' | 'github_discussions';
  url: string; access_environment?: string | null; run_id: string | null;
  scan_complete: boolean | null; finished_at: Date | null };
type DocumentRow = QueryResultRow & { id: string; source_id: string; external_key: string; source_url: string;
  source_title: string | null; source_created_at: Date | null; source_updated_at: Date | null;
  collected_at: Date; source_repository: string | null; synthetic: boolean };
type SignalRow = QueryResultRow & { id: string; state: string; signal_type: SignalType; source_type: string;
  summary: string; interpretation_limit: string; evidence: Record<string, unknown>; observed_at: Date;
  created_at: Date; reviewed_at: Date | null; review_reason: string | null; obsolete_reason: string | null;
  rule_version: string; test_data: boolean; read_at?: Date | null };

function hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
type HistoricalKey = { id: string; fact_key: string; state: string;
  evidence: Record<string, unknown>; updated_at: Date };
export function signalKeyForHistory(baseKey: string, coverage: unknown, history: HistoricalKey[]): string {
  const active = history.find(row => row.state !== 'obsolete' && row.evidence.coverage === coverage);
  if (active) return active.fact_key;
  const latest = history[0];
  return latest ? hash([baseKey, latest.id, latest.updated_at, coverage]) : baseKey;
}
function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function string(value: unknown): string | null { return typeof value === 'string' && value.trim() ? value : null; }
function containsRenderedQuote(page: string, quote: string): boolean {
  return page.replace(/\s+/g, ' ').includes(quote.replace(/\s+/g, ' '));
}
function testUrl(value: string): boolean {
  try { const host = new URL(value).hostname.toLowerCase();
    return host === 'example.com' || host.endsWith('.example.com') || host.endsWith('.invalid');
  } catch { return true; }
}
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new BadRequestException(result.error.issues.map(issue => issue.message));
  return result.data;
}

// A successful HTTP fetch is insufficient: both interpretations and both literal
// supporting excerpts must be present. These checks mirror evidence.ts but are
// deliberately narrower for reviewable signals.
export function pageFact(row: PageRow, detail: unknown, productIds: string[]): Fact | null {
  const value = object(detail); if (!value) return null;
  const previous = object(value.previous); const current = object(value.current);
  const products = [...new Set(productIds)].sort();
  if (row.source_type === 'pricing_page' && value.kind === 'price_observed' && previous && current) {
    const oldName = string(previous.name); const newName = string(current.name);
    const oldAmount = string(previous.amount); const newAmount = string(current.amount);
    const currency = string(previous.currency); const period = string(previous.period);
    const conditions = string(previous.conditions);
    const oldQuote = string(previous.evidence); const newQuote = string(current.evidence);
    if (!oldName || oldName !== newName || !oldAmount || !newAmount || oldAmount === newAmount ||
      !/^\d+(?:\.\d+)?$/.test(oldAmount) || !/^\d+(?:\.\d+)?$/.test(newAmount) ||
      !currency || currency !== current.currency || !period || period !== current.period ||
      !conditions || conditions !== current.conditions || previous.confirmed !== true || current.confirmed !== true ||
      !oldQuote || !newQuote || !containsRenderedQuote(row.previous_text, oldQuote) ||
      !containsRenderedQuote(row.current_text, newQuote)) return null;
    const evidence = { source_type: row.source_type, product_ids: products, page_change_id: row.id,
      previous: { snapshot_id: row.previous_snapshot_id, content_hash: row.previous_hash,
        url: row.previous_url, at: row.previous_at, quote: oldQuote, amount: oldAmount },
      current: { snapshot_id: row.current_snapshot_id, content_hash: row.current_hash,
        url: row.current_url, at: row.current_at, quote: newQuote, amount: newAmount },
      plan: oldName, currency, period, conditions };
    return { key: hash([signalRuleVersion, 'price', row.previous_url, row.previous_hash, row.current_hash,
      oldName, oldAmount, newAmount, currency, period, conditions, products]), type: 'price_change',
      sourceType: row.source_type, sourceId: row.source_id, pageChangeId: row.id,
      previousSnapshotId: row.previous_snapshot_id, currentSnapshotId: row.current_snapshot_id,
      summary: `Preço listado de ${oldName}: ${currency} ${oldAmount}/${period} → ${currency} ${newAmount}/${period}`,
      limit: 'Valor observado em duas capturas comparáveis; não confirma oferta contratual nem impacto comercial.',
      evidence, observedAt: row.current_at, testData: testUrl(row.source_url) || process.env.MARKETRIFT_TEST_MODE === '1' };
  }
  if (row.source_type === 'release_notes' && value.kind === 'entry_appeared' && current && !previous) {
    const title = string(current.title); const quote = string(current.evidence); const url = string(current.url);
    const entries = Array.isArray(row.current_extracted.entries) ? row.current_extracted.entries : [];
    if (!title || !quote || !url || !entries.some(entry => {
      const candidate = object(entry);
      return candidate?.title === title && candidate.url === url && candidate.evidence === quote;
    })) return null;
    try { if (new URL(url).hostname !== new URL(row.current_url).hostname) return null; }
    catch { return null; }
    const evidence = { source_type: row.source_type, product_ids: products, page_change_id: row.id,
      previous: { snapshot_id: row.previous_snapshot_id, content_hash: row.previous_hash,
        url: row.previous_url, at: row.previous_at, quote: row.previous_text.slice(0, 300) },
      current: { snapshot_id: row.current_snapshot_id, content_hash: row.current_hash,
        url: row.current_url, at: row.current_at, quote, entry_url: url,
        entry_title: title, entry_date: current.date ?? null } };
    return { key: hash([signalRuleVersion, 'release', row.previous_url, row.previous_hash,
      row.current_hash, url, title, products]), type: 'release_entry', sourceType: row.source_type,
      sourceId: row.source_id, pageChangeId: row.id, previousSnapshotId: row.previous_snapshot_id,
      currentSnapshotId: row.current_snapshot_id, summary: `Nova entrada no changelog: ${title}`,
      limit: 'Entrada observada no changelog público; não demonstra adoção, impacto ou uso por clientes.',
      evidence, observedAt: row.current_at, testData: testUrl(row.source_url) || process.env.MARKETRIFT_TEST_MODE === '1' };
  }
  return null;
}

function repository(url: string): string | null {
  try { const parsed = new URL(url); if (parsed.hostname !== 'github.com') return null;
    const parts = parsed.pathname.split('/').filter(Boolean); return parts.length === 2 ? parts.join('/').toLowerCase() : null;
  } catch { return null; }
}
function documentRepository(url: string, type: PublicRow['source_type']): string | null {
  try { const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com') return null;
    const parts = parsed.pathname.split('/').filter(Boolean);
    if (parts.length < 4 || parts[2] !== (type === 'github_issues' ? 'issues' : 'discussions')) return null;
    return `${parts[0]}/${parts[1]}`.toLowerCase();
  } catch { return null; }
}

export function activityFact(sources: PublicRow[], documents: DocumentRow[]): Fact | null {
  const firstSource = sources[0];
  if (!firstSource || !sources.some(source => source.run_id)) return null;
  const repo = repository(firstSource.url); if (!repo || sources.some(source => repository(source.url) !== repo)) return null;
  const sourceType = firstSource.source_type;
  const docs = new Map<string, DocumentRow>();
  for (const document of documents) {
    if (document.synthetic || !document.external_key || documentRepository(document.source_url, sourceType) !== repo) continue;
    const previous = docs.get(document.external_key);
    if (!previous || (document.source_updated_at ?? document.collected_at) >
      (previous.source_updated_at ?? previous.collected_at)) docs.set(document.external_key, document);
  }
  const unique = [...docs.values()].sort((a, b) => a.external_key.localeCompare(b.external_key));
  if (!unique.length) return null;
  const productIds = [...new Set(sources.map(source => source.product_id))].sort();
  const evidence = { repository: repo, source_ids: sources.map(source => source.id).sort(), product_ids: productIds,
    source_type: sourceType, unit: 'documento público distinto armazenado', count: unique.length,
    coverage: sources.every(source => source.scan_complete) ? 'complete_for_latest_scan' : 'partial_cursor',
    latest_runs: sources.map(source => ({ source_id: source.id, run_id: source.run_id,
      scan_complete: source.scan_complete, finished_at: source.finished_at })),
    examples: unique.slice(0, 20).map(document => ({ document_id: document.id, url: document.source_url,
      title: document.source_title, observed_at: document.source_created_at ?? document.collected_at })),
    examples_truncated: unique.length > 20 };
  const timestamps = unique.map(document => document.source_created_at ?? document.collected_at);
  const latest = new Date(Math.max(...timestamps.map(value => value.getTime())));
  const noun = sourceType === 'github_issues' ? 'Issues' : 'Discussions';
  return { key: hash([signalRuleVersion, sourceType, repo, productIds, unique.map(document =>
    [document.external_key, document.source_updated_at ?? document.collected_at])]),
    type: sourceType === 'github_issues' ? 'github_issue_activity' : 'github_discussion_activity',
    sourceType, sourceId: firstSource.id, pageChangeId: null, previousSnapshotId: null, currentSnapshotId: null,
    summary: `${unique.length} ${noun} públicas armazenadas de ${repo}`,
    limit: `${noun} são atividade pública do repositório, não reviews de clientes. A coleta pode estar parcial por cursor; o total não representa todo o histórico.`,
    evidence: { ...evidence, observed_from: new Date(Math.min(...timestamps.map(value => value.getTime()))),
    observed_to: latest }, observedAt: latest,
    testData: sources.some(source => source.access_environment === 'sandbox') || process.env.MARKETRIFT_TEST_MODE === '1' };
}

@Controller('v1/reviewable-signals')
export class ReviewableSignalsController {
  constructor(@Inject(Db) private readonly db: Db, @Inject(Accounts) private readonly accounts: Accounts) {}

  @Post('refresh')
  async refresh(@Req() request: Request): Promise<{ candidates: number; new_candidates: number; obsolete: number }> {
    const principal = await this.accounts.principal(request, ['owner', 'admin']);
    return this.db.tenant(principal.tenantId, async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 7176166010))',
        [principal.tenantId]);
      const result = await reconcileSignals(this.db, client, principal.tenantId);
      await client.query(`UPDATE marketrift.signal_reconcile_sources SET processed_revision=requested_revision,
        last_reconciled_at=now(),last_error=NULL,attempts=0,next_attempt_at=now()
        WHERE tenant_id=$1`, [principal.tenantId]);
      return result;
    });
  }

  @Get()
  async list(@Req() request: Request): Promise<{ signals: SignalRow[]; alerts: SignalRow[];
    real_count: number; test_count: number; reconciliation: { last_at: Date | null; pending: number;
      failed: number; reasons: string[] } }> {
    const principal = await this.accounts.principal(request);
    return this.db.tenant(principal.tenantId, async client => {
      const projection = `SELECT r.id,r.state,r.signal_type,r.source_type,r.summary,r.interpretation_limit,
        r.evidence,r.observed_at,r.created_at,r.reviewed_at,r.review_reason,r.obsolete_reason,
        r.rule_version,r.test_data,reads.read_at FROM marketrift.reviewable_signals r
        LEFT JOIN marketrift.signal_alert_reads reads ON reads.tenant_id=r.tenant_id
          AND reads.signal_id=r.id AND reads.user_id=$2`;
      const rows = await this.db.rows<SignalRow>(client, `${projection}
        WHERE r.tenant_id=$1 AND ($3::boolean=false OR r.state='approved')
        ORDER BY r.observed_at DESC,r.id LIMIT 100`,
      [principal.tenantId, principal.userId, principal.role === 'viewer']);
      const alerts = await this.db.rows<SignalRow>(client, `${projection}
        WHERE r.tenant_id=$1 AND r.state='approved' AND r.reviewed_at >= now() - interval '30 days'
        ORDER BY r.reviewed_at DESC,r.id LIMIT 20`, [principal.tenantId, principal.userId]);
      const counts = await this.db.rows<{ real_count: number; test_count: number }>(client, `SELECT
        count(*) FILTER (WHERE NOT test_data AND state <> 'obsolete')::integer AS real_count,
        count(*) FILTER (WHERE test_data AND state <> 'obsolete')::integer AS test_count
        FROM marketrift.reviewable_signals WHERE tenant_id=$1`, [principal.tenantId]);
      const reconciliation = await this.db.rows<{ last_at: Date | null; pending: number; failed: number }>(client,
        `SELECT max(last_reconciled_at) AS last_at,
          count(*) FILTER (WHERE requested_revision>processed_revision)::integer AS pending,
          count(*) FILTER (WHERE requested_revision>processed_revision AND last_error IS NOT NULL)::integer AS failed
          FROM marketrift.signal_reconcile_sources WHERE tenant_id=$1`, [principal.tenantId]);
      const reasons = await this.db.rows<{ last_error: string }>(client,
        `SELECT DISTINCT last_error FROM marketrift.signal_reconcile_sources
          WHERE tenant_id=$1 AND requested_revision>processed_revision AND last_error IS NOT NULL LIMIT 3`,
        [principal.tenantId]);
      return { signals: rows, alerts, real_count: counts[0]?.real_count ?? 0,
        test_count: counts[0]?.test_count ?? 0,
        reconciliation: { last_at: reconciliation[0]?.last_at ?? null,
          pending: reconciliation[0]?.pending ?? 0, failed: reconciliation[0]?.failed ?? 0,
          reasons: reasons.map(row => row.last_error) } };
    });
  }

  @Post(':id/review')
  async review(@Req() request: Request, @Param('id') value: string, @Body() body: unknown): Promise<{ state: string }> {
    const principal = await this.accounts.principal(request, ['owner', 'admin']);
    const id = parse(uuid, value); const input = parse(decision, body);
    return this.db.tenant(principal.tenantId, async client => {
      const row = await this.db.rows<{ id: string; state: string }>(client, `UPDATE marketrift.reviewable_signals
        SET state=$3,review_reason=$4,reviewed_by=$5,reviewed_at=now(),updated_at=now()
        WHERE tenant_id=$1 AND id=$2 AND state='candidate' RETURNING id,state`,
      [principal.tenantId, id, input.state, input.reason, principal.userId]);
      if (!row[0]) throw new NotFoundException('Candidato inexistente, já revisado ou obsoleto nesta empresa');
      return { state: row[0].state };
    });
  }

  @Post(':id/read')
  async read(@Req() request: Request, @Param('id') value: string, @Body() body: unknown): Promise<{ read: boolean }> {
    const principal = await this.accounts.principal(request);
    const id = parse(uuid, value); const input = parse(readInput, body);
    return this.db.tenant(principal.tenantId, async client => {
      const approved = await this.db.rows<{ id: string }>(client, `SELECT id FROM marketrift.reviewable_signals
        WHERE tenant_id=$1 AND id=$2 AND state='approved'`, [principal.tenantId, id]);
      if (!approved[0]) throw new NotFoundException('Alerta aprovado não encontrado nesta empresa');
      if (input.read) await client.query(`INSERT INTO marketrift.signal_alert_reads (tenant_id,signal_id,user_id)
        VALUES ($1,$2,$3) ON CONFLICT (tenant_id,signal_id,user_id) DO NOTHING`,
      [principal.tenantId, id, principal.userId]);
      else await client.query(`DELETE FROM marketrift.signal_alert_reads WHERE tenant_id=$1 AND signal_id=$2 AND user_id=$3`,
      [principal.tenantId, id, principal.userId]);
      return { read: input.read };
    });
  }
}

export async function signalFacts(db: Db, client: PoolClient): Promise<Fact[]> {
    const pages = await db.rows<PageRow>(client, `SELECT c.id, c.source_id, s.product_id, s.source_type,
      s.url AS source_url, c.previous_snapshot_id, c.current_snapshot_id, c.change_details,
      prev.final_url AS previous_url, next.final_url AS current_url,
      prev.content_sha256 AS previous_hash, next.content_sha256 AS current_hash,
      prev.normalized_text AS previous_text, next.normalized_text AS current_text,
      prev.extracted AS previous_extracted, next.extracted AS current_extracted,
      prev.fetched_at AS previous_at, next.fetched_at AS current_at, c.detected_at
      FROM marketrift.page_changes c JOIN marketrift.sources s ON s.tenant_id=c.tenant_id AND s.id=c.source_id
      JOIN marketrift.source_snapshots prev ON prev.tenant_id=c.tenant_id AND prev.id=c.previous_snapshot_id
      JOIN marketrift.source_snapshots next ON next.tenant_id=c.tenant_id AND next.id=c.current_snapshot_id
      WHERE s.enabled AND s.source_type IN ('pricing_page','release_notes')
        AND prev.interpretation_version >= 2 AND next.interpretation_version >= 2
        AND prev.interpretation_status='confirmed' AND next.interpretation_status='confirmed'
      ORDER BY c.detected_at DESC, c.id LIMIT 2001`);
    if (pages.length > 2000) throw new ConflictException('Mais de 2000 mudanças; reduza o lote antes de gerar sinais');
    const preliminaries = pages.flatMap(row => row.change_details.map(detail => pageFact(row, detail, [row.product_id]))
      .filter((item): item is Fact => item !== null));
    const groupedPages = new Map<string, Fact[]>();
    for (const fact of preliminaries) {
      const e = fact.evidence; const previous = object(e.previous); const current = object(e.current);
      const shared = hash([fact.type, previous?.url, previous?.content_hash, current?.content_hash,
        e.plan ?? current?.entry_url, previous?.amount, current?.amount]);
      groupedPages.set(shared, [...(groupedPages.get(shared) ?? []), fact]);
    }
    const facts: Fact[] = [];
    for (const group of groupedPages.values()) {
      const first = group[0]; if (!first) continue;
      const products = [...new Set(group.flatMap(fact => fact.evidence.product_ids as string[]))].sort();
      const sourceIds = [...new Set(group.map(fact => fact.sourceId))].sort();
      const previous = object(first.evidence.previous); const current = object(first.evidence.current);
      const shared = hash([first.type, previous?.url, previous?.content_hash, current?.content_hash,
        first.evidence.plan ?? current?.entry_url, previous?.amount, current?.amount]);
      facts.push({ ...first, key: hash([signalRuleVersion, shared, products, sourceIds]),
        evidence: { ...first.evidence, product_ids: products, source_ids: sourceIds,
          ambiguous_association: products.length > 1 } });
    }
    const publicSources = await db.rows<PublicRow>(client, `SELECT s.id, s.product_id, s.source_type, s.url, s.access_environment,
      latest.id AS run_id, latest.scan_complete, latest.finished_at
      FROM marketrift.sources s LEFT JOIN LATERAL (
        SELECT r.id, r.scan_complete, r.finished_at FROM marketrift.source_runs r
        WHERE r.tenant_id=s.tenant_id AND r.source_id=s.id AND r.status='succeeded'
        ORDER BY r.finished_at DESC, r.id DESC LIMIT 1
      ) latest ON true
      WHERE s.enabled AND s.source_type IN ('github_issues','github_discussions') ORDER BY s.id LIMIT 501`);
    if (publicSources.length > 500) throw new ConflictException('Mais de 500 fontes públicas; reduza o lote');
    const groups = new Map<string, PublicRow[]>();
    for (const source of publicSources) {
      const repo = repository(source.url); if (!repo) continue;
      const key = `${source.source_type}:${repo}`; groups.set(key, [...(groups.get(key) ?? []), source]);
    }
    for (const group of groups.values()) {
      const first = group[0]; if (!first) continue;
      const sourceIds = group.map(source => source.id);
      const rows = await db.rows<DocumentRow>(client, `SELECT id, source_id, external_key, source_url,
        source_title, source_created_at, source_updated_at, collected_at, source_repository, synthetic
        FROM marketrift.documents WHERE source_id = ANY($1::uuid[])
          AND document_type=$2 ORDER BY id LIMIT 5001`, [sourceIds,
        first.source_type === 'github_issues' ? 'github_issue' : 'github_discussion']);
      if (rows.length > 5000) throw new ConflictException('Mais de 5000 documentos numa origem; reduza o lote');
      const fact = activityFact(group, rows); if (fact) facts.push(fact);
    }
    return facts;
  }

export async function reconcileSignals(db: Db, client: PoolClient, tenantId: string):
  Promise<{ candidates: number; new_candidates: number; obsolete: number }> {
  const facts = await signalFacts(db, client);
  const keys: string[] = [];
  let inserted = 0;
  for (const fact of facts) {
    // An unchanged active fact keeps its approval. A coverage transition or a
    // return after obsolescence creates another row and leaves history intact.
    const history = await db.rows<HistoricalKey>(client,
      `SELECT id,fact_key,state,evidence,updated_at FROM marketrift.reviewable_signals
        WHERE tenant_id=$1 AND (fact_key=$2 OR evidence->>'base_fact_key'=$2)
        ORDER BY created_at DESC,id DESC`, [tenantId, fact.key]);
    const factKey = signalKeyForHistory(fact.key, fact.evidence.coverage, history);
    const evidence = factKey === fact.key ? fact.evidence : { ...fact.evidence, base_fact_key: fact.key };
    keys.push(factKey);
    const rows = await db.rows<{ id: string }>(client, `INSERT INTO marketrift.reviewable_signals
      (tenant_id,fact_key,rule_version,signal_type,source_type,source_id,page_change_id,
      previous_snapshot_id,current_snapshot_id,summary,interpretation_limit,evidence,evidence_hash,
      observed_at,test_data)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      ON CONFLICT (tenant_id,fact_key) DO NOTHING RETURNING id`,
    [tenantId, factKey, signalRuleVersion, fact.type, fact.sourceType, fact.sourceId,
      fact.pageChangeId, fact.previousSnapshotId, fact.currentSnapshotId, fact.summary, fact.limit,
      evidence, hash(evidence), fact.observedAt, fact.testData]);
    inserted += rows.length;
    if (!rows.length) await client.query(`UPDATE marketrift.reviewable_signals
      SET evidence=$3,evidence_hash=$4,updated_at=now()
      WHERE tenant_id=$1 AND fact_key=$2 AND state<>'obsolete' AND evidence_hash<>$4`,
    [tenantId, factKey, evidence, hash(evidence)]);
  }
  const obsolete = await db.rows<{ id: string }>(client, `UPDATE marketrift.reviewable_signals
    SET state='obsolete', obsolete_reason='evidence_changed_removed_or_source_disabled',
      evidence=jsonb_build_object('withdrawn',true,'reason','evidence_changed_removed_or_source_disabled'),
      summary='Sinal sem suporte atual',
      interpretation_limit='Origem alterada, removida ou desativada; revise um novo candidato antes de concluir.',
      updated_at=now()
    WHERE tenant_id=$1 AND state <> 'obsolete' AND rule_version=$2
      AND NOT (fact_key = ANY($3::char(64)[])) RETURNING id`,
  [tenantId, signalRuleVersion, keys]);
  return { candidates: facts.length, new_candidates: inserted, obsolete: obsolete.length };
}
