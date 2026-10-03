import { Controller, Get, Inject, Req } from '@nestjs/common';
import type { Request } from 'express';
import type { QueryResultRow } from 'pg';
import { Accounts } from './accounts';
import { Db } from './db';

type Product = QueryResultRow & { id: string; name: string; kind: string; website_url: string | null;
  official_domain: string | null; discovery_paused: boolean | null };
type Source = QueryResultRow & { id: string; product_id: string; source_type: string; url: string;
  evidence_count: number; last_observed_at: Date | null; partial: boolean; blocked: boolean;
  association_confirmed: boolean };
type Discovery = QueryResultRow & { product_id: string; status: string; partial: boolean;
  finished_at: Date | null; retry_after_at: Date | null };
type Suggestion = QueryResultRow & { product_id: string; count: number };
type Attention = QueryResultRow & { id: string; summary: string; state: string; observed_at: Date;
  read_at: Date | null };

@Controller('v1/experience')
export class ExperienceController {
  constructor(@Inject(Db) private readonly db: Db, @Inject(Accounts) private readonly accounts: Accounts) {}

  @Get()
  async list(@Req() request: Request): Promise<{ products: Product[]; sources: Source[];
    discovery: Discovery[]; suggestions: Suggestion[]; attention: Attention[] }> {
    const principal = await this.accounts.principal(request);
    return this.db.tenant(principal.tenantId, async client => {
      const products = await this.db.rows<Product>(client, `SELECT p.id,p.name,p.kind,p.website_url,
        cp.official_domain,cp.discovery_paused FROM marketrift.products p
        LEFT JOIN marketrift.competitor_profiles cp ON cp.tenant_id=p.tenant_id AND cp.product_id=p.id
        WHERE p.usage_classification='real' ORDER BY p.created_at,p.id`);
      const sources = await this.db.rows<Source>(client, `SELECT s.id,s.product_id,s.source_type,s.url,
        (coalesce(d.total,0)+coalesce(ss.total,0)+coalesce(fe.total,0))::integer AS evidence_count,
        greatest(d.last_at,ss.last_at,fe.last_at) AS last_observed_at,
        coalesce(run.scan_complete=false,false) AS partial,
        (lower(split_part(split_part(s.url,'://',2),'/',1))=cp.official_domain
          OR lower(split_part(split_part(s.url,'://',2),'/',1)) LIKE '%.'||cp.official_domain
          OR EXISTS (SELECT 1 FROM marketrift.discovery_candidates c
            WHERE c.tenant_id=s.tenant_id AND c.product_id=s.product_id
              AND c.test_data=false AND c.status='confirmed'
              AND c.identity_version=cp.identity_version
              AND (c.linked_source_id=s.id OR c.canonical_url=s.url))) AS association_confirmed,
        (s.source_type='g2' AND (s.access_status<>'authorized' OR NOT s.storage_permitted
          OR s.rights_expires_at IS NULL OR s.rights_expires_at<=now()))
          OR (s.source_type='b2b_csv_review' AND (NOT s.storage_permitted
          OR s.rights_reference IS NULL OR s.rights_expires_at IS NULL OR s.rights_expires_at<=now()))
          OR coalesce(run.status='failed',false) AS blocked
        FROM marketrift.sources s JOIN marketrift.products p
          ON p.tenant_id=s.tenant_id AND p.id=s.product_id
        LEFT JOIN marketrift.competitor_profiles cp ON cp.tenant_id=s.tenant_id AND cp.product_id=s.product_id
        LEFT JOIN LATERAL (SELECT count(*)::integer AS total,max(d.collected_at) AS last_at
          FROM marketrift.documents d WHERE d.tenant_id=s.tenant_id AND d.source_id=s.id
            AND NOT d.synthetic AND d.document_type IN ('b2b_review','g2_review','steam_review','github_issue','github_discussion')
            AND (d.document_type<>'b2b_review' OR (d.review_data_status='declared_real'
              AND s.enabled AND s.storage_permitted AND s.rights_reference IS NOT NULL AND s.rights_expires_at>now()))
            AND (d.document_type<>'g2_review' OR (d.review_data_status='declared_real'
              AND s.access_environment='production' AND s.access_status='authorized'
              AND s.storage_permitted AND s.rights_reference IS NOT NULL AND s.rights_expires_at>now()))) d ON true
        LEFT JOIN LATERAL (SELECT count(*)::integer AS total,max(fetched_at) AS last_at
          FROM marketrift.source_snapshots WHERE tenant_id=s.tenant_id AND source_id=s.id
            AND normalized_text IS NOT NULL AND NOT (s.source_type='public_page'
              AND (interpretation_reason='insufficient_main_content'
                OR lower(trim(normalized_text))='skip to content'))) ss ON true
        LEFT JOIN LATERAL (SELECT count(*)::integer AS total,max(updated_at) AS last_at
          FROM marketrift.feed_entries WHERE tenant_id=s.tenant_id AND source_id=s.id) fe ON true
        LEFT JOIN LATERAL (SELECT status,scan_complete FROM marketrift.source_runs
          WHERE tenant_id=s.tenant_id AND source_id=s.id ORDER BY started_at DESC,id DESC LIMIT 1) run ON true
        WHERE p.usage_classification='real' AND s.usage_classification='real'
          AND s.access_environment IS DISTINCT FROM 'sandbox'
          AND s.source_type <> 'manual_review'
        ORDER BY p.name,s.source_type,s.id`);
      const discovery = await this.db.rows<Discovery>(client, `SELECT DISTINCT ON (r.product_id)
        r.product_id,r.status,r.partial,r.finished_at,r.retry_after_at
        FROM marketrift.discovery_runs r JOIN marketrift.products p
          ON p.tenant_id=r.tenant_id AND p.id=r.product_id
        JOIN marketrift.competitor_profiles cp
          ON cp.tenant_id=r.tenant_id AND cp.product_id=r.product_id
        WHERE p.usage_classification='real' AND r.test_data=false
          AND r.identity_version=cp.identity_version
        ORDER BY r.product_id,r.created_at DESC,r.id DESC`);
      const suggestions = await this.db.rows<Suggestion>(client, `SELECT c.product_id,count(*)::integer AS count
        FROM marketrift.discovery_candidates c JOIN marketrift.products p
          ON p.tenant_id=c.tenant_id AND p.id=c.product_id
        JOIN marketrift.competitor_profiles cp
          ON cp.tenant_id=c.tenant_id AND cp.product_id=c.product_id
        WHERE p.usage_classification='real' AND c.test_data=false
          AND c.identity_version=cp.identity_version AND c.status='pending'
          AND c.linked_source_id IS NULL AND NOT EXISTS (SELECT 1 FROM marketrift.sources s
            WHERE s.tenant_id=c.tenant_id AND s.product_id=c.product_id AND s.url=c.canonical_url)
        GROUP BY c.product_id`);
      const attention = await this.db.rows<Attention>(client, `SELECT r.id,r.summary,r.state,r.observed_at,
        reads.read_at FROM marketrift.reviewable_signals r
        JOIN marketrift.sources s ON s.tenant_id=r.tenant_id AND s.id=r.source_id
        JOIN marketrift.products p ON p.tenant_id=s.tenant_id AND p.id=s.product_id
        LEFT JOIN marketrift.signal_alert_reads reads ON reads.tenant_id=r.tenant_id
          AND reads.signal_id=r.id AND reads.user_id=$1
        WHERE p.usage_classification='real' AND s.usage_classification='real'
          AND s.access_environment IS DISTINCT FROM 'sandbox' AND NOT r.test_data
          AND (r.state='approved' OR (r.state='candidate' AND $2::boolean))
        ORDER BY r.observed_at DESC,r.id DESC LIMIT 10`,
      [principal.userId, principal.role !== 'viewer']);
      return { products, sources, discovery, suggestions, attention };
    });
  }
}
