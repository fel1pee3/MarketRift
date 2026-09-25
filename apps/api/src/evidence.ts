import { BadRequestException, Controller, Get, Inject, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import type { QueryResultRow } from 'pg';
import { z } from 'zod';
import { Accounts } from './accounts';
import { activeExtractorVersion } from './analysis-job';
import { Db } from './db';

const sourceType = z.enum(['csv_review', 'b2b_review', 'g2_review', 'steam_review', 'github_issue', 'github_discussion',
  'pricing_page', 'release_notes']);
const date = z.iso.date();
const filtersSchema = z.object({
  product_id: z.uuid().optional(), source_type: sourceType.optional(),
  from: date.optional(), to: date.optional(),
  q: z.string().trim().min(1).max(120).optional(),
  limit: z.coerce.number<number>().int().min(1).max(50).default(20),
  offset: z.coerce.number<number>().int().min(0).max(1000).default(0),
}).strict().refine(value => !value.from || !value.to || value.from <= value.to,
  { message: 'from must not be after to', path: ['from'] });
type Filters = z.infer<typeof filtersSchema>;

type EvidenceRow = QueryResultRow & {
  item_id: string; source_id: string; source_type: z.infer<typeof sourceType>;
  product_id: string; product_name: string; product_ids: string[]; product_names: string[];
  origin_key: string; source_url: string; title: string | null; excerpt: string;
  observed_at: Date; collected_at: Date; synthetic: boolean; data_status: string | null;
  interpretation_status: string | null; interpretation_reason: string | null;
  content_status: string | null; association_count: number; duplicate_rows: number;
  analysis_status: string | null; analysis_model: string | null;
  issues: { category: string; severity: string; description: string; evidence_quote: string }[];
};
type CountRow = QueryResultRow & { source_type: string; count: number; ambiguous_count: number;
  first_at: Date; last_at: Date };
type PartialRow = QueryResultRow & { source_id: string; source_type: string; product_name: string; last_run_at: Date };
type ReviewBucket = QueryResultRow & { source_type: 'csv_review' | 'b2b_review' | 'g2_review' | 'steam_review'; synthetic: boolean; data_status: string;
  total_reviews: number; analyzed_reviews: number; documents_without_analysis: number };
type CategoryRow = QueryResultRow & { source_type: 'csv_review' | 'b2b_review' | 'g2_review' | 'steam_review'; synthetic: boolean; data_status: string;
  category: string; documents_with_problem: number };
type PageEvent = QueryResultRow & { id: string; source_type: 'pricing_page' | 'release_notes';
  product_id: string; product_name: string; product_ids: string[]; source_url: string;
  previous_url: string; current_url: string; previous_at: Date; current_at: Date;
  detected_at: Date; detail: Record<string, unknown>; association_count: number };

function filters(value: unknown): Filters {
  const parsed = filtersSchema.safeParse(value);
  if (!parsed.success) throw new BadRequestException(parsed.error.issues.map(issue =>
    `${issue.path.join('.')}: ${issue.message}`));
  return parsed.data;
}

// Each identity is tenant-local. Product associations are calculated before the
// product filter, so a shared Steam App ID or repository is counted once and flagged.
const evidenceBase = `WITH raw AS (
  SELECT d.id AS item_id, d.source_id, s.product_id, p.name AS product_name,
    CASE WHEN d.document_type = 'review' THEN 'csv_review' ELSE d.document_type END AS source_type,
    CASE d.document_type
      WHEN 'steam_review' THEN jsonb_build_array(d.steam_app_id, d.external_key)::text
      WHEN 'github_issue' THEN jsonb_build_array(coalesce(d.source_repository, s.url), d.external_key)::text
      WHEN 'github_discussion' THEN jsonb_build_array(coalesce(d.source_repository, s.url), d.external_key)::text
      WHEN 'g2_review' THEN jsonb_build_array(s.external_product_id, s.access_environment, d.external_key)::text
      ELSE jsonb_build_array(d.source_url, d.external_key)::text END AS origin_key,
    d.source_url, d.source_title AS title, left(d.body, 500) AS excerpt,
    d.body AS search_text, coalesce(d.published_at, d.source_created_at, d.collected_at) AS observed_at,
    d.collected_at, d.synthetic, d.review_data_status AS data_status, NULL::text AS interpretation_status,
    NULL::text AS interpretation_reason, d.discussion_content_status AS content_status
  FROM marketrift.documents d
  JOIN marketrift.sources s ON s.tenant_id = d.tenant_id AND s.id = d.source_id
  JOIN marketrift.products p ON p.tenant_id = s.tenant_id AND p.id = s.product_id
  WHERE d.document_type IN ('review', 'b2b_review', 'g2_review', 'steam_review', 'github_issue', 'github_discussion')
  UNION ALL
  SELECT ss.id, ss.source_id, s.product_id, p.name, s.source_type,
    jsonb_build_array(coalesce(ss.final_url, s.url), ss.content_sha256)::text,
    coalesce(ss.final_url, s.url), NULL::text, left(ss.normalized_text, 500),
    ss.normalized_text, ss.fetched_at, ss.fetched_at, false, NULL::text,
    ss.interpretation_status, ss.interpretation_reason, NULL::text
  FROM marketrift.source_snapshots ss
  JOIN marketrift.sources s ON s.tenant_id = ss.tenant_id AND s.id = ss.source_id
  JOIN marketrift.products p ON p.tenant_id = s.tenant_id AND p.id = s.product_id
  WHERE s.source_type IN ('pricing_page', 'release_notes') AND ss.version_no IS NOT NULL
    AND ss.normalized_text IS NOT NULL
), associations AS (
  SELECT source_type, origin_key, array_agg(DISTINCT product_id) AS product_ids,
    array_agg(DISTINCT product_name) AS product_names,
    count(DISTINCT product_id)::integer AS association_count, count(*)::integer AS duplicate_rows,
    bool_or(synthetic) AS any_synthetic
  FROM raw GROUP BY source_type, origin_key
), matched AS (
  SELECT r.* FROM raw r WHERE ($1::uuid IS NULL OR r.product_id = $1)
    AND ($2::text IS NULL OR r.source_type = $2)
    AND ($3::date IS NULL OR r.observed_at >= $3::date)
    AND ($4::date IS NULL OR r.observed_at < $4::date + interval '1 day')
    AND ($5::text IS NULL OR strpos(lower(coalesce(r.title, '') || ' ' || r.search_text), lower($5)) > 0)
), dedup AS (
  SELECT DISTINCT ON (source_type, origin_key) * FROM matched
  ORDER BY source_type, origin_key, observed_at DESC, collected_at DESC, item_id
)`;

const reviewsBase = `WITH all_reviews AS (
  SELECT d.id, s.product_id,
    CASE WHEN d.document_type = 'review' THEN 'csv_review' ELSE d.document_type END AS source_type,
    CASE WHEN d.document_type = 'steam_review' THEN jsonb_build_array(d.steam_app_id, d.external_key)::text
      WHEN d.document_type = 'g2_review' THEN jsonb_build_array(s.external_product_id, s.access_environment, d.external_key)::text
      ELSE jsonb_build_array(d.source_url, d.external_key)::text END AS origin_key,
    d.synthetic, coalesce(d.review_data_status,
      CASE WHEN d.document_type = 'steam_review' THEN 'steam_public' ELSE 'unverified_legacy' END) AS data_status,
    d.body, d.source_updated_at, d.collected_at,
    coalesce(d.published_at, d.source_created_at, d.collected_at) AS observed_at,
    coalesce(a.status = 'completed' AND a.model_id IS NOT NULL
      AND (d.synthetic OR a.model_id <> 'controlled-test-fixture-v1'), false) AS analyzed
  FROM marketrift.documents d
  JOIN marketrift.sources s ON s.tenant_id = d.tenant_id AND s.id = d.source_id
  LEFT JOIN marketrift.document_analyses a ON a.tenant_id = d.tenant_id
    AND a.document_id = d.id AND a.extractor_version = $5
  WHERE d.document_type IN ('review', 'b2b_review', 'g2_review', 'steam_review')
), origin_flags AS (
  SELECT source_type, origin_key, bool_or(synthetic) AS any_synthetic
  FROM all_reviews GROUP BY source_type, origin_key
), matched AS (
  SELECT * FROM all_reviews WHERE ($1::uuid IS NULL OR product_id = $1)
    AND ($2::text IS NULL OR source_type = $2)
    AND ($3::date IS NULL OR observed_at >= $3::date)
    AND ($4::date IS NULL OR observed_at < $4::date + interval '1 day')
), dedup AS (
  SELECT DISTINCT ON (m.source_type, m.origin_key) m.*, f.any_synthetic AS synthetic_group
  FROM matched m JOIN origin_flags f USING (source_type, origin_key)
  ORDER BY m.source_type, m.origin_key, m.source_updated_at DESC NULLS LAST,
    m.collected_at DESC, m.id
)`;

// Only two v2 confirmed snapshots and structured, comparable details qualify.
// An observed textual difference or a legacy interpretation remains searchable,
// but never becomes a confirmed price/release event.
const pageEventsBase = `WITH raw AS (
  SELECT c.id, s.product_id, p.name AS product_name, s.source_type, s.url AS source_url,
    prev.final_url AS previous_url, next.final_url AS current_url,
    prev.fetched_at AS previous_at, next.fetched_at AS current_at, c.detected_at,
    detail.value AS detail,
    md5(jsonb_build_array(s.source_type, prev.final_url, prev.content_sha256,
      next.content_sha256, detail.value)::text) AS event_key
  FROM marketrift.page_changes c
  JOIN marketrift.sources s ON s.tenant_id = c.tenant_id AND s.id = c.source_id
  JOIN marketrift.products p ON p.tenant_id = s.tenant_id AND p.id = s.product_id
  JOIN marketrift.source_snapshots prev ON prev.tenant_id = c.tenant_id AND prev.id = c.previous_snapshot_id
  JOIN marketrift.source_snapshots next ON next.tenant_id = c.tenant_id AND next.id = c.current_snapshot_id
  CROSS JOIN LATERAL jsonb_array_elements(c.change_details) AS detail(value)
  WHERE prev.interpretation_version >= 2 AND next.interpretation_version >= 2
    AND prev.interpretation_status = 'confirmed' AND next.interpretation_status = 'confirmed'
    AND ((s.source_type = 'pricing_page' AND detail.value->>'kind' = 'price_observed'
      AND detail.value->'previous'->>'confirmed' = 'true'
      AND detail.value->'current'->>'confirmed' = 'true'
      AND nullif(detail.value->'previous'->>'conditions', '') IS NOT NULL
      AND detail.value->'previous'->>'conditions' = detail.value->'current'->>'conditions'
      AND detail.value->'previous'->>'currency' = detail.value->'current'->>'currency'
      AND detail.value->'previous'->>'period' = detail.value->'current'->>'period'
      AND detail.value->'previous'->>'amount' <> detail.value->'current'->>'amount')
      OR (s.source_type = 'release_notes' AND detail.value->>'kind' IN ('entry_appeared', 'entry_changed')
        AND nullif(detail.value->'current'->>'url', '') IS NOT NULL
        AND nullif(detail.value->'current'->>'evidence', '') IS NOT NULL))
), associations AS (
  SELECT event_key, array_agg(DISTINCT product_id) AS product_ids,
    count(DISTINCT product_id)::integer AS association_count FROM raw GROUP BY event_key
), matched AS (
  SELECT DISTINCT ON (event_key) * FROM raw
  WHERE ($1::uuid IS NULL OR product_id = $1)
    AND ($2::text IS NULL OR source_type = $2)
    AND ($3::date IS NULL OR detected_at >= $3::date)
    AND ($4::date IS NULL OR detected_at < $4::date + interval '1 day')
  ORDER BY event_key, detected_at DESC, id
)`;

@Controller('v1/evidence')
export class EvidenceController {
  constructor(@Inject(Db) private readonly db: Db, @Inject(Accounts) private readonly accounts: Accounts) {}

  @Get('search')
  async search(@Req() request: Request, @Query() query: unknown): Promise<{
    items: EvidenceRow[]; counts: CountRow[]; total: number; ambiguous_total: number; observed_from: Date | null;
    observed_to: Date | null; partial_sources: PartialRow[]; limit: number; offset: number;
  }> {
    const principal = await this.accounts.principal(request);
    const f = filters(query);
    const args = [f.product_id ?? null, f.source_type ?? null, f.from ?? null, f.to ?? null, f.q ?? null];
    return this.db.tenant(principal.tenantId, async client => {
      const counts = await this.db.rows<CountRow>(client, `${evidenceBase}
        SELECT d.source_type, count(*)::integer AS count,
          count(*) FILTER (WHERE a.association_count > 1)::integer AS ambiguous_count,
          min(d.observed_at) AS first_at, max(d.observed_at) AS last_at
        FROM dedup d JOIN associations a USING (source_type, origin_key)
        GROUP BY d.source_type ORDER BY d.source_type`, args);
      const items = await this.db.rows<EvidenceRow>(client, `${evidenceBase}
        SELECT d.item_id, d.source_id, d.source_type, d.product_id, d.product_name,
          a.product_ids, a.product_names, d.origin_key, d.source_url, d.title, d.excerpt,
          d.observed_at, d.collected_at, a.any_synthetic AS synthetic, d.data_status, d.interpretation_status,
          d.interpretation_reason, d.content_status, a.association_count, a.duplicate_rows,
          analysis.status AS analysis_status, analysis.model_id AS analysis_model,
          COALESCE((SELECT json_agg(json_build_object('category', i.category,
            'severity', i.severity, 'description', i.pain_point, 'evidence_quote', i.evidence_quote)
            ORDER BY i.issue_index) FROM marketrift.insights i
            WHERE i.tenant_id = analysis.tenant_id AND i.analysis_id = analysis.id
              AND analysis.status = 'completed'), '[]'::json) AS issues
        FROM dedup d JOIN associations a USING (source_type, origin_key)
        LEFT JOIN marketrift.document_analyses analysis ON d.source_type = 'b2b_review'
          AND analysis.tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
          AND analysis.document_id = d.item_id AND analysis.extractor_version = $8
        ORDER BY d.observed_at DESC, d.item_id LIMIT $6 OFFSET $7`,
      [...args, f.limit, f.offset, activeExtractorVersion]);
      const partialSources = await this.db.rows<PartialRow>(client, `WITH latest AS (
        SELECT DISTINCT ON (r.source_id) r.source_id, r.scan_complete, r.finished_at,
          s.source_type, p.name AS product_name
        FROM marketrift.source_runs r
        JOIN marketrift.sources s ON s.tenant_id = r.tenant_id AND s.id = r.source_id
        JOIN marketrift.products p ON p.tenant_id = s.tenant_id AND p.id = s.product_id
        WHERE r.status = 'succeeded' AND r.scan_complete IS NOT NULL
          AND ($1::uuid IS NULL OR s.product_id = $1)
          AND ($2::text IS NULL OR s.source_type = CASE $2::text
            WHEN 'csv_review' THEN 'manual_review' WHEN 'steam_review' THEN 'steam_reviews'
            WHEN 'github_issue' THEN 'github_issues' WHEN 'github_discussion' THEN 'github_discussions'
            WHEN 'g2_review' THEN 'g2' WHEN 'b2b_review' THEN 'b2b_csv_review'
            ELSE $2 END)
        ORDER BY r.source_id, r.finished_at DESC, r.id DESC
      ) SELECT source_id, source_type, product_name, finished_at AS last_run_at
        FROM latest WHERE scan_complete = false ORDER BY finished_at DESC LIMIT 50`, args.slice(0, 2));
      return { items, counts, total: counts.reduce((sum, row) => sum + row.count, 0),
        ambiguous_total: counts.reduce((sum, row) => sum + row.ambiguous_count, 0),
        observed_from: counts.length ? new Date(Math.min(...counts.map(row => row.first_at.getTime()))) : null,
        observed_to: counts.length ? new Date(Math.max(...counts.map(row => row.last_at.getTime()))) : null,
        partial_sources: partialSources, limit: f.limit, offset: f.offset };
    });
  }

  @Get('signals')
  async signals(@Req() request: Request, @Query() query: unknown): Promise<{
    review_buckets: ReviewBucket[]; categories: CategoryRow[]; page_events: PageEvent[];
    page_events_truncated: boolean; extractor_version: string;
  }> {
    const principal = await this.accounts.principal(request);
    const f = filters(query);
    if (f.q) throw new BadRequestException('Term search applies to evidence, not signal denominators');
    const args = [f.product_id ?? null, f.source_type ?? null, f.from ?? null, f.to ?? null, activeExtractorVersion];
    return this.db.tenant(principal.tenantId, async client => {
      const reviewBuckets = await this.db.rows<ReviewBucket>(client, `${reviewsBase}
        SELECT source_type, synthetic_group AS synthetic, data_status, count(*)::integer AS total_reviews,
          count(*) FILTER (WHERE analyzed)::integer AS analyzed_reviews,
          count(*) FILTER (WHERE NOT analyzed)::integer AS documents_without_analysis
        FROM dedup GROUP BY source_type, synthetic_group, data_status ORDER BY source_type, synthetic_group, data_status`, args);
      const categories = await this.db.rows<CategoryRow>(client, `${reviewsBase}
        SELECT d.source_type, d.synthetic_group AS synthetic, d.data_status, i.category,
          count(DISTINCT d.id)::integer AS documents_with_problem
        FROM dedup d JOIN marketrift.insights i ON i.document_id = d.id
          AND i.extractor_version = $5 AND i.analysis_id IS NOT NULL
        WHERE d.analyzed AND i.sentiment = 'negative' AND i.evidence_quote IS NOT NULL
          AND strpos(d.body, i.evidence_quote) > 0
        GROUP BY d.source_type, d.synthetic_group, d.data_status, i.category
        ORDER BY d.source_type, d.synthetic_group, d.data_status, i.category`, args);
      const events = await this.db.rows<PageEvent>(client, `${pageEventsBase}
        SELECT m.id, m.source_type, m.product_id, m.product_name, a.product_ids,
          m.source_url, m.previous_url, m.current_url, m.previous_at, m.current_at,
          m.detected_at, m.detail, a.association_count
        FROM matched m JOIN associations a USING (event_key)
        ORDER BY m.detected_at DESC, m.id LIMIT 51`, args.slice(0, 4));
      return { review_buckets: reviewBuckets, categories, page_events: events.slice(0, 50),
        page_events_truncated: events.length > 50, extractor_version: activeExtractorVersion };
    });
  }
}
