import { BadRequestException, Controller, Get, Inject, NotFoundException, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import type { QueryResultRow } from 'pg';
import { z } from 'zod';
import { Accounts } from './accounts';
import { Db } from './db';

const types = ['csv_review', 'b2b_review', 'g2_review', 'steam_review', 'github_issue',
  'github_discussion', 'pricing_page', 'release_notes', 'rss_feed', 'public_page'] as const;
const filterSchema = z.object({ product_id: z.uuid().optional(), source_types: z.string().max(200).optional(),
  from: z.iso.date().optional(), to: z.iso.date().optional(),
  limit: z.coerce.number<number>().int().min(1).max(50).default(20),
  offset: z.coerce.number<number>().int().min(0).max(1000).default(0) }).strict();
export function timelineFilters(value: unknown): { productId: string | null; sourceTypes: string[] | null;
  from: string | null; to: string | null; limit: number; offset: number } {
  const parsed = filterSchema.safeParse(value);
  if (!parsed.success) throw new BadRequestException(parsed.error.issues.map(issue => issue.message));
  const f = parsed.data;
  if (f.from && f.to && f.from > f.to) throw new BadRequestException('Data inicial depois da final');
  const selected = f.source_types?.split(',').map(item => item.trim()) ?? null;
  if (selected && (!selected.length || selected.some(item => !types.includes(item as typeof types[number])) ||
    new Set(selected).size !== selected.length)) throw new BadRequestException('Tipos de fonte inválidos ou repetidos');
  return { productId: f.product_id ?? null, sourceTypes: selected,
    from: f.from ?? null, to: f.to ?? null, limit: f.limit, offset: f.offset };
}

type Kind = 'document' | 'snapshot' | 'changelog_entry' | 'price_change';
type RawRow = QueryResultRow & { item_id: string; identity_key: string; kind: Kind; source_type: string;
  source_id: string; source_ids: string[]; relation_ids: string[]; product_ids: string[];
  product_names: string[]; association_count: number; title: string | null; excerpt: string;
  source_url: string; origin_reported_at: Date | null; origin_date_literal: string | null;
  observed_at: Date; capture_at: Date | null; structure_observed_at: Date | null;
  interpretation_at: Date | null; rule_version: string | null; interpretation_status: string | null;
  interpretation_reason: string | null; interpretation_basis: string | null;
  capture_complete: boolean | null; version_no: number | null; content_sha256: string | null;
  synthetic: boolean; synthetic_group: boolean; any_synthetic: boolean;
  all_confirmed: boolean; any_partial: boolean;
  data_status: string | null; detail: Record<string, unknown> | null;
  coverages: string[]; total: number };
type SignalLinkRow = QueryResultRow & { id: string; source_id: string; page_change_id: string | null;
  previous_snapshot_id: string | null; current_snapshot_id: string | null;
  signal_type: string; state: string; evidence: Record<string, unknown>;
  change_details: Record<string, unknown>[] | null;
  reviewed_at: Date | null; hypothesis_id: string | null; hypothesis_status: string | null;
  hypothesis_reviewed_at: Date | null };
export type TimelineLink = { signal_id: string; signal_state: string; hypothesis_id: string | null;
  hypothesis_status: string | null; signal_reviewed_at: Date | null; hypothesis_reviewed_at: Date | null;
  relation: 'activity_of_source' | 'capture_used' | 'same_entry' | 'same_change' };
export type TimelineItem = Omit<RawRow, 'total' | 'identity_key' | 'source_id' | 'relation_ids' |
  'synthetic_group' | 'any_synthetic' | 'all_confirmed' | 'any_partial'> & {
  event_id: string; status: 'observed' | 'confirmed' | 'partial' | 'unconfirmed';
  coverage: 'partial_cursor' | 'latest_scan_complete' | 'unknown' | 'not_applicable';
  links: TimelineLink[] };

// Associations are calculated before the product filter. Each distinct origin or
// captured fact appears once even if two products share its repository/App ID/URL.
function timelineSql(raw: string, firstObservation = false): string {
  return `WITH raw AS (${raw}), associations AS (
    SELECT identity_key, array_agg(DISTINCT product_id) AS product_ids,
      array_agg(DISTINCT product_name) AS product_names,
      array_agg(DISTINCT source_id) AS source_ids,
      array_agg(DISTINCT relation_id) AS relation_ids,
      array_agg(DISTINCT coverage) AS coverages,
      count(DISTINCT product_id)::integer AS association_count,
      bool_or(synthetic) AS any_synthetic,
      bool_and(CASE WHEN kind='snapshot' THEN coalesce(capture_complete,false)
        AND coalesce(interpretation_status='confirmed',false) AND rule_version IS NOT NULL
        AND rule_version <> '1' ELSE true END) AS all_confirmed,
      bool_or(CASE WHEN kind='snapshot' THEN NOT coalesce(capture_complete,false)
        OR coalesce(interpretation_status='partial',false) ELSE false END) AS any_partial
    FROM raw GROUP BY identity_key
  ), matched AS (
    SELECT DISTINCT ON (r.identity_key) r.*, a.product_ids,a.product_names,a.source_ids,
      a.relation_ids,a.coverages,a.association_count,a.any_synthetic,a.all_confirmed,a.any_partial
    FROM raw r JOIN associations a USING (identity_key)
    WHERE ($1::uuid IS NULL OR r.product_id=$1)
      AND ($2::text[] IS NULL OR r.source_type=ANY($2::text[]))
      AND ($3::date IS NULL OR r.observed_at >= ($3::date::timestamp AT TIME ZONE 'UTC'))
      AND ($4::date IS NULL OR r.observed_at < (($4::date + 1)::timestamp AT TIME ZONE 'UTC'))
    ORDER BY r.identity_key,r.observed_at ${firstObservation ? 'ASC' : 'DESC'},r.item_id
  ) SELECT m.*,m.any_synthetic AS synthetic_group,count(*) OVER()::integer AS total
    FROM matched m ORDER BY m.observed_at DESC,m.item_id LIMIT $5`;
}

const documentsSql = timelineSql(`SELECT d.id::text AS item_id,
  md5(jsonb_build_array(d.document_type,
    CASE d.document_type
      WHEN 'steam_review' THEN jsonb_build_array(d.steam_app_id,d.external_key)
      WHEN 'github_issue' THEN jsonb_build_array(coalesce(d.source_repository,s.url),d.external_key)
      WHEN 'github_discussion' THEN jsonb_build_array(coalesce(d.source_repository,s.url),d.external_key)
      WHEN 'g2_review' THEN jsonb_build_array(s.external_product_id,s.access_environment,d.external_key)
      ELSE jsonb_build_array(d.source_url,d.external_key) END)::text) AS identity_key,
  'document'::text AS kind,
  CASE WHEN d.document_type='review' THEN 'csv_review' ELSE d.document_type END AS source_type,
  d.source_id,s.product_id,p.name AS product_name,d.id AS relation_id,
  d.source_title AS title,left(d.body,500) AS excerpt,d.source_url,
  coalesce(d.published_at,d.source_created_at) AS origin_reported_at,
  NULL::text AS origin_date_literal,d.collected_at AS observed_at,
  NULL::timestamptz AS capture_at,NULL::timestamptz AS structure_observed_at,
  NULL::timestamptz AS interpretation_at,NULL::text AS rule_version,
  NULL::text AS interpretation_status,d.discussion_content_status AS interpretation_reason,
  NULL::text AS interpretation_basis,NULL::boolean AS capture_complete,
  NULL::integer AS version_no,NULL::text AS content_sha256,
  (d.synthetic OR s.access_environment='sandbox') AS synthetic,d.review_data_status AS data_status,
  jsonb_build_object('external_key',d.external_key,'repository',d.source_repository,
    'state',d.source_state,'category',d.discussion_category,'content_status',d.discussion_content_status) AS detail,
  CASE WHEN d.document_type IN ('github_issue','github_discussion') THEN
    CASE WHEN latest.scan_complete=false THEN 'partial_cursor'
      WHEN latest.scan_complete=true THEN 'latest_scan_complete' ELSE 'unknown' END
    ELSE 'not_applicable' END AS coverage
  FROM marketrift.documents d
  JOIN marketrift.sources s ON s.tenant_id=d.tenant_id AND s.id=d.source_id
  JOIN marketrift.products p ON p.tenant_id=s.tenant_id AND p.id=s.product_id
  LEFT JOIN LATERAL (SELECT r.scan_complete FROM marketrift.source_runs r
    WHERE r.tenant_id=d.tenant_id AND r.source_id=d.source_id AND r.status='succeeded'
      AND r.scan_complete IS NOT NULL ORDER BY r.finished_at DESC,r.id DESC LIMIT 1) latest ON true
  WHERE d.document_type IN ('review','b2b_review','g2_review','steam_review','github_issue','github_discussion')
    AND (d.document_type <> 'b2b_review' OR (s.enabled AND s.storage_permitted
      AND s.rights_reference IS NOT NULL
      AND (s.access_environment='sandbox' OR s.rights_expires_at > now())))`);

const snapshotsSql = timelineSql(`SELECT ss.id::text AS item_id,
  md5(jsonb_build_array(s.source_type,coalesce(ss.final_url,s.url),ss.content_sha256)::text) AS identity_key,
  'snapshot'::text AS kind,s.source_type,ss.source_id,s.product_id,p.name AS product_name,
  ss.id AS relation_id,coalesce(ss.extracted->>'title',('Captura v' || ss.version_no)::text) AS title,
  CASE WHEN s.source_type='public_page' AND (ss.interpretation_reason='insufficient_main_content'
    OR lower(trim(ss.normalized_text))='skip to content') THEN ''
    ELSE left(ss.normalized_text,500) END AS excerpt,coalesce(ss.final_url,s.url) AS source_url,
  CASE WHEN s.source_type='public_page' AND ss.extracted->>'origin_date_basis' IS DISTINCT FROM 'feed_metadata'
    AND ss.extracted->'origin_date_evidence' IS NOT NULL THEN
    (ss.extracted->>'origin_reported_at')::timestamptz ELSE NULL END AS origin_reported_at,
  CASE WHEN s.source_type='public_page' AND ss.extracted->>'origin_date_basis' IS DISTINCT FROM 'feed_metadata'
    AND ss.extracted->'origin_date_evidence' IS NOT NULL THEN
    ss.extracted->>'origin_date_literal' ELSE NULL END AS origin_date_literal,
  ss.fetched_at AS observed_at,ss.fetched_at AS capture_at,
  ss.markup_observed_at AS structure_observed_at,i.finished_at AS interpretation_at,
  ss.interpretation_version::text AS rule_version,ss.interpretation_status,
  ss.interpretation_reason,i.basis AS interpretation_basis,ss.capture_complete,
  ss.version_no,ss.content_sha256,s.access_environment='sandbox' AS synthetic,
  NULL::text AS data_status,NULL::jsonb AS detail,'not_applicable'::text AS coverage
  FROM marketrift.source_snapshots ss
  JOIN marketrift.sources s ON s.tenant_id=ss.tenant_id AND s.id=ss.source_id
  JOIN marketrift.products p ON p.tenant_id=s.tenant_id AND p.id=s.product_id
  LEFT JOIN LATERAL (SELECT basis,finished_at FROM marketrift.snapshot_interpretations i
    WHERE i.tenant_id=ss.tenant_id AND i.snapshot_id=ss.id AND i.status='completed'
      AND i.rule_version=ss.interpretation_version
    ORDER BY i.finished_at DESC LIMIT 1) i ON true
  WHERE s.source_type IN ('pricing_page','release_notes','public_page') AND ss.version_no IS NOT NULL
    AND ss.normalized_text IS NOT NULL`);

const feedSql = timelineSql(`SELECT (e.id::text || ':' || v.version_no::text) AS item_id,
  md5(jsonb_build_array('rss_feed',s.url,e.external_id,v.version_no,v.content_sha256)::text) AS identity_key,
  'document'::text AS kind,'rss_feed'::text AS source_type,
  e.source_id,s.product_id,p.name AS product_name,e.id AS relation_id,
  v.title AS title,v.title AS excerpt,v.canonical_url AS source_url,
  v.published_at AS origin_reported_at,v.date_literal AS origin_date_literal,
  v.observed_at AS observed_at,NULL::timestamptz AS capture_at,
  NULL::timestamptz AS structure_observed_at,NULL::timestamptz AS interpretation_at,
  'rss-atom-v1'::text AS rule_version,'observed'::text AS interpretation_status,
  'metadata_only'::text AS interpretation_reason,NULL::text AS interpretation_basis,
  latest.scan_complete AS capture_complete,v.version_no,v.content_sha256,
  s.access_environment='sandbox' AS synthetic,NULL::text AS data_status,
  jsonb_build_object('feed_url',s.url,'external_id',e.external_id) AS detail,
  CASE WHEN latest.scan_complete=false THEN 'partial_cursor'
    WHEN latest.scan_complete=true THEN 'latest_scan_complete' ELSE 'unknown' END AS coverage
  FROM marketrift.feed_entries e
  JOIN marketrift.feed_entry_versions v ON v.tenant_id=e.tenant_id AND v.entry_id=e.id
  JOIN marketrift.sources s ON s.tenant_id=e.tenant_id AND s.id=e.source_id
  JOIN marketrift.products p ON p.tenant_id=s.tenant_id AND p.id=s.product_id
  LEFT JOIN LATERAL (SELECT scan_complete FROM marketrift.source_runs
    WHERE tenant_id=e.tenant_id AND source_id=e.source_id AND run_kind='feed'
      AND status='succeeded' ORDER BY finished_at DESC,id DESC LIMIT 1) latest ON true`);

const entriesSql = timelineSql(`SELECT ss.id::text || ':' || coalesce(e.entry->>'url','') AS item_id,
  md5(jsonb_build_array('changelog_entry',e.entry->>'url',e.entry->>'title',e.entry->>'evidence')::text)
    AS identity_key,'changelog_entry'::text AS kind,'release_notes'::text AS source_type,
  ss.source_id,s.product_id,p.name AS product_name,ss.id AS relation_id,
  e.entry->>'title' AS title,left(e.entry->>'evidence',500) AS excerpt,
  e.entry->>'url' AS source_url,NULL::timestamptz AS origin_reported_at,
  coalesce(nullif(e.entry->>'date_evidence',''),nullif(e.entry->>'date','')) AS origin_date_literal,
  CASE WHEN i.basis='later_same_text_capture' THEN
    greatest(ss.fetched_at,coalesce(ss.markup_observed_at,ss.fetched_at))
    ELSE ss.fetched_at END AS observed_at,
  ss.fetched_at AS capture_at,
  CASE WHEN i.basis='later_same_text_capture' THEN ss.markup_observed_at
    ELSE ss.fetched_at END AS structure_observed_at,
  i.finished_at AS interpretation_at,ss.interpretation_version::text AS rule_version,
  ss.interpretation_status,ss.interpretation_reason,i.basis AS interpretation_basis,
  ss.capture_complete,ss.version_no,ss.content_sha256,
  s.access_environment='sandbox' AS synthetic,NULL::text AS data_status,
  jsonb_build_object('title_evidence',e.entry->>'title_evidence',
    'url_evidence',e.entry->>'url_evidence') AS detail,'not_applicable'::text AS coverage
  FROM marketrift.source_snapshots ss
  JOIN marketrift.sources s ON s.tenant_id=ss.tenant_id AND s.id=ss.source_id
  JOIN marketrift.products p ON p.tenant_id=s.tenant_id AND p.id=s.product_id
  LEFT JOIN LATERAL (SELECT basis,finished_at FROM marketrift.snapshot_interpretations i
    WHERE i.tenant_id=ss.tenant_id AND i.snapshot_id=ss.id AND i.status='completed'
      AND i.rule_version=ss.interpretation_version
    ORDER BY i.finished_at DESC LIMIT 1) i ON true
  CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(ss.extracted->'entries')='array'
    THEN ss.extracted->'entries' ELSE '[]'::jsonb END) e(entry)
  WHERE s.source_type='release_notes' AND ss.version_no IS NOT NULL
    AND ss.interpretation_version >= 2 AND ss.interpretation_status='confirmed'
    AND ss.capture_complete AND nullif(e.entry->>'title','') IS NOT NULL
    AND nullif(e.entry->>'evidence','') IS NOT NULL AND nullif(e.entry->>'url','') IS NOT NULL
    AND coalesce(nullif(e.entry->>'date_evidence',''),nullif(e.entry->>'date','')) IS NOT NULL
    AND strpos(e.entry->>'evidence',e.entry->>'title') > 0
    AND substring(e.entry->>'url' from '^https://[^/]+') =
      substring(coalesce(ss.final_url,s.url) from '^https://[^/]+')
    AND strpos(regexp_replace(ss.normalized_text,'\\s+',' ','g'),
      regexp_replace(e.entry->>'evidence','\\s+',' ','g')) > 0`, true);

const pricesSql = timelineSql(`SELECT c.id::text AS item_id,
  md5(jsonb_build_array('price_change',prev.final_url,prev.content_sha256,next.content_sha256,
    detail.value->'previous'->>'name',detail.value->'previous'->>'amount',
    detail.value->'current'->>'amount')::text) AS identity_key,
  'price_change'::text AS kind,'pricing_page'::text AS source_type,
  c.source_id,s.product_id,p.name AS product_name,c.id AS relation_id,
  detail.value->'current'->>'name' AS title,
  left('Antes: ' || (detail.value->'previous'->>'evidence') ||
    ' | Depois: ' || (detail.value->'current'->>'evidence'),500) AS excerpt,
  coalesce(next.final_url,s.url) AS source_url,NULL::timestamptz AS origin_reported_at,
  NULL::text AS origin_date_literal,next.fetched_at AS observed_at,
  next.fetched_at AS capture_at,next.markup_observed_at AS structure_observed_at,
  c.detected_at AS interpretation_at,
  (prev.interpretation_version::text || '/' || next.interpretation_version::text) AS rule_version,
  'confirmed'::text AS interpretation_status,'two_comparable_captures'::text AS interpretation_reason,
  'two_captures'::text AS interpretation_basis,true AS capture_complete,
  next.version_no,next.content_sha256,s.access_environment='sandbox' AS synthetic,
  NULL::text AS data_status,detail.value AS detail,'not_applicable'::text AS coverage
  FROM marketrift.page_changes c
  JOIN marketrift.sources s ON s.tenant_id=c.tenant_id AND s.id=c.source_id
  JOIN marketrift.products p ON p.tenant_id=s.tenant_id AND p.id=s.product_id
  JOIN marketrift.source_snapshots prev ON prev.tenant_id=c.tenant_id AND prev.id=c.previous_snapshot_id
  JOIN marketrift.source_snapshots next ON next.tenant_id=c.tenant_id AND next.id=c.current_snapshot_id
  CROSS JOIN LATERAL jsonb_array_elements(c.change_details) detail(value)
  WHERE s.source_type='pricing_page' AND prev.capture_complete AND next.capture_complete
    AND prev.interpretation_version >= 2 AND next.interpretation_version >= 2
    AND prev.interpretation_status='confirmed' AND next.interpretation_status='confirmed'
    AND NOT EXISTS (SELECT 1 FROM marketrift.snapshot_interpretations i
      WHERE i.tenant_id=c.tenant_id AND i.snapshot_id IN (prev.id,next.id)
        AND i.basis <> 'initial_capture' AND i.status='completed' AND i.finished_at > c.detected_at)
    AND detail.value->>'kind'='price_observed'
    AND detail.value->'previous'->>'confirmed'='true'
    AND detail.value->'current'->>'confirmed'='true'
    AND nullif(detail.value->'previous'->>'name','') IS NOT NULL
    AND detail.value->'previous'->>'name'=detail.value->'current'->>'name'
    AND (detail.value->'previous'->>'amount') ~ '^[0-9]+([.][0-9]+)?$'
    AND (detail.value->'current'->>'amount') ~ '^[0-9]+([.][0-9]+)?$'
    AND detail.value->'previous'->>'amount'<>detail.value->'current'->>'amount'
    AND nullif(detail.value->'previous'->>'currency','') IS NOT NULL
    AND detail.value->'previous'->>'currency'=detail.value->'current'->>'currency'
    AND nullif(detail.value->'previous'->>'period','') IS NOT NULL
    AND detail.value->'previous'->>'period'=detail.value->'current'->>'period'
    AND nullif(detail.value->'previous'->>'conditions','') IS NOT NULL
    AND detail.value->'previous'->>'conditions'=detail.value->'current'->>'conditions'
    AND nullif(detail.value->'previous'->>'evidence','') IS NOT NULL
    AND nullif(detail.value->'current'->>'evidence','') IS NOT NULL
    AND strpos(regexp_replace(prev.normalized_text,'\\s+',' ','g'),
      regexp_replace(detail.value->'previous'->>'evidence','\\s+',' ','g')) > 0
    AND strpos(regexp_replace(next.normalized_text,'\\s+',' ','g'),
      regexp_replace(detail.value->'current'->>'evidence','\\s+',' ','g')) > 0`);

function coverage(values: string[]): TimelineItem['coverage'] {
  if (values.includes('partial_cursor')) return 'partial_cursor';
  if (values.includes('unknown')) return 'unknown';
  if (values.includes('latest_scan_complete')) return 'latest_scan_complete';
  return 'not_applicable';
}
export function linkFor(row: Pick<RawRow, 'kind' | 'source_type' | 'source_url' | 'source_ids' | 'relation_ids'>,
  signal: SignalLinkRow): TimelineLink['relation'] | null {
  if (!row.source_ids.includes(signal.source_id)) return null;
  if (row.kind === 'document') {
    if ((row.source_type === 'github_issue' && signal.signal_type === 'github_issue_activity') ||
      (row.source_type === 'github_discussion' && signal.signal_type === 'github_discussion_activity'))
      return 'activity_of_source';
    return null;
  }
  if (row.kind === 'price_change' && signal.signal_type === 'price_change' &&
    signal.page_change_id && row.relation_ids.includes(signal.page_change_id)) return 'same_change';
  if (row.kind === 'snapshot' && (signal.previous_snapshot_id && row.relation_ids.includes(signal.previous_snapshot_id) ||
    signal.current_snapshot_id && row.relation_ids.includes(signal.current_snapshot_id))) return 'capture_used';
  if (row.kind === 'changelog_entry' && signal.signal_type === 'release_entry' &&
    signal.current_snapshot_id && row.relation_ids.includes(signal.current_snapshot_id)) {
    const current = signal.evidence.current;
    if (current && typeof current === 'object' && 'entry_url' in current && current.entry_url === row.source_url)
      return 'same_entry';
    if (signal.change_details?.some(detail => detail.kind === 'entry_appeared' &&
      detail.current && typeof detail.current === 'object' &&
      'url' in detail.current && detail.current.url === row.source_url)) return 'same_entry';
  }
  return null;
}

@Controller('v1/evidence')
export class EvidenceTimelineController {
  constructor(@Inject(Db) private readonly db: Db, @Inject(Accounts) private readonly accounts: Accounts) {}

  @Get('timeline')
  async timeline(@Req() request: Request, @Query() query: unknown): Promise<{ items: TimelineItem[];
    total: number; limit: number; offset: number; date_basis: string }> {
    const principal = await this.accounts.principal(request);
    const f = timelineFilters(query);
    return this.db.tenant(principal.tenantId, async client => {
      if (f.productId) {
        const product = await this.db.rows<{ id: string }>(client,
          'SELECT id FROM marketrift.products WHERE id=$1', [f.productId]);
        if (!product[0]) throw new NotFoundException('Produto não encontrado na empresa ativa');
      }
      const args = [f.productId, f.sourceTypes, f.from, f.to, f.offset + f.limit];
      // One PostgreSQL transaction owns one client; issue its queries in order.
      const documents = await this.db.rows<RawRow>(client, documentsSql, args);
      const snapshots = await this.db.rows<RawRow>(client, snapshotsSql, args);
      const entries = await this.db.rows<RawRow>(client, entriesSql, args);
      const prices = await this.db.rows<RawRow>(client, pricesSql, args);
      const feeds = await this.db.rows<RawRow>(client, feedSql, args);
      const total = [documents, snapshots, entries, prices, feeds].reduce((sum, rows) => sum + (rows[0]?.total ?? 0), 0);
      const selected = [...documents, ...snapshots, ...entries, ...prices, ...feeds]
        .sort((a, b) => b.observed_at.getTime() - a.observed_at.getTime() || a.item_id.localeCompare(b.item_id))
        .slice(f.offset, f.offset + f.limit);
      const sourceIds = [...new Set(selected.flatMap(row => row.source_ids))];
      const signals = sourceIds.length ? await this.db.rows<SignalLinkRow>(client, `SELECT r.id,r.source_id,
        r.page_change_id,r.previous_snapshot_id,r.current_snapshot_id,r.signal_type,r.state,r.evidence,
        r.reviewed_at,c.change_details,h.id AS hypothesis_id,h.status AS hypothesis_status,
        h.reviewed_at AS hypothesis_reviewed_at
        FROM marketrift.reviewable_signals r
        LEFT JOIN marketrift.page_changes c ON c.tenant_id=r.tenant_id AND c.id=r.page_change_id
        LEFT JOIN marketrift.action_hypotheses h ON h.tenant_id=r.tenant_id AND h.signal_id=r.id
          AND ($2::boolean=false OR h.status='approved')
        WHERE r.source_id=ANY($1::uuid[]) AND ($2::boolean=false OR r.state='approved')`,
      [sourceIds, principal.role === 'viewer']) : [];
      const items: TimelineItem[] = selected.map(row => {
        const { total: _total, identity_key: _identityKey, source_id: _sourceId,
          relation_ids: _relationIds, any_synthetic: _anySynthetic, synthetic_group: _syntheticGroup,
          all_confirmed: _allConfirmed, any_partial: _anyPartial,
          ...publicRow } = row;
        void _total; void _identityKey; void _sourceId; void _relationIds;
        void _anySynthetic; void _syntheticGroup; void _allConfirmed; void _anyPartial;
        const status: TimelineItem['status'] = row.source_type === 'public_page'
          ? row.interpretation_reason === 'insufficient_main_content' || !row.excerpt ? 'unconfirmed'
            : row.capture_complete ? 'observed' : 'partial' : row.kind === 'changelog_entry' || row.kind === 'price_change'
          ? 'confirmed' : row.kind === 'document' ? 'observed'
            : row.any_partial ? 'partial' : row.all_confirmed ? 'confirmed' : 'unconfirmed';
        const links = signals.flatMap(signal => {
          const relation = linkFor(row, signal);
          return relation ? [{ signal_id: signal.id, signal_state: signal.state,
            hypothesis_id: signal.hypothesis_id, hypothesis_status: signal.hypothesis_status,
            signal_reviewed_at: signal.reviewed_at, hypothesis_reviewed_at: signal.hypothesis_reviewed_at,
            relation }] : [];
        });
        return { ...publicRow, event_id: `${row.kind}:${row.identity_key}`, synthetic: row.synthetic_group,
          status, coverage: coverage(row.coverages), links };
      });
      return { items, total, limit: f.limit, offset: f.offset,
        date_basis: 'observed_at_utc; source dates and interpretation dates are separate' };
    });
  }
}
