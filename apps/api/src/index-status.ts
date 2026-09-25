import type { PoolClient, QueryResultRow } from 'pg';
import { Db } from './db';

type SourceRow = QueryResultRow & { id: string; source_type: string; enabled: boolean };
type ItemRow = QueryResultRow & { source_id: string; item_id: string; kind: 'document' | 'snapshot';
  text_content: string; content_version: string };
type VectorRow = QueryResultRow & { source_id: string; item_id: string; kind: 'document' | 'snapshot';
  chunk_no: number; content_version: string; text_content: string };
type CountRow = QueryResultRow & { source_id: string; count: number };

export type SourceIndexStatus = { source_id: string; source_type: string; state: 'complete' | 'partial' |
  'not_indexed_for_model' | 'no_eligible_content' | 'disabled'; total_chunks: number;
  ready_chunks: number; controlled_test_chunks: number };

// Keep this boundary identical to Python evidence_index.chunks. A full source is
// only reported complete after every expected chunk number has a current vector.
export function expectedChunkCount(text: string): number {
  const clean = Array.from(text.trim()); // Python's len() counts Unicode code points, not UTF-16 units.
  if (!clean.length) return 0;
  let start = 0;
  let count = 0;
  while (start < clean.length) {
    if (++count > 100) return 101;
    let end = Math.min(start + 480, clean.length);
    if (end < clean.length) {
      for (let position = end - 1; position >= start + 300; position--) {
        if (clean[position] === ' ') { end = position; break; }
      }
    }
    if (end === clean.length) break;
    start = Math.max(start + 1, end - 60);
  }
  return count;
}

export async function sourceIndexStatus(db: Db, client: PoolClient, model: string, version: string,
  sourceId?: string): Promise<SourceIndexStatus[]> {
  const sources = await db.rows<SourceRow>(client, `SELECT id, source_type, enabled FROM marketrift.sources
    WHERE source_type IN ('manual_review', 'b2b_csv_review', 'github_issues', 'github_discussions',
      'pricing_page', 'release_notes') AND ($1::uuid IS NULL OR id = $1)
    ORDER BY id LIMIT 101`, [sourceId ?? null]);
  if (sources.length > 100) throw new Error('source_index_status_limit_exceeded');
  if (!sources.length) return [];
  const ids = sources.map(source => source.id);
  const items = await db.rows<ItemRow>(client, `SELECT d.source_id, d.id AS item_id, 'document'::text AS kind,
      d.body AS text_content, md5(d.body) AS content_version
    FROM marketrift.documents d JOIN marketrift.sources s ON s.tenant_id = d.tenant_id AND s.id = d.source_id
    WHERE d.source_id = ANY($1::uuid[]) AND s.enabled AND length(btrim(d.body)) > 0
      AND ((d.document_type = 'github_issue' AND s.source_type = 'github_issues')
        OR (d.document_type = 'github_discussion' AND s.source_type = 'github_discussions')
        OR (d.document_type = 'review' AND d.synthetic AND d.review_data_status = 'synthetic_fixture')
        OR (d.document_type = 'b2b_review' AND s.source_type = 'b2b_csv_review'
          AND s.storage_permitted AND s.rights_reference IS NOT NULL
          AND ((d.synthetic AND d.review_data_status = 'synthetic_fixture')
            OR (NOT d.synthetic AND d.review_data_status = 'declared_real'
              AND s.access_environment = 'production'
              AND (s.rights_expires_at IS NULL OR s.rights_expires_at > now()))))
      )
    UNION ALL
    SELECT ss.source_id, ss.id, 'snapshot'::text, ss.normalized_text, md5(ss.normalized_text)
    FROM marketrift.source_snapshots ss
    JOIN marketrift.sources s ON s.tenant_id = ss.tenant_id AND s.id = ss.source_id
    WHERE ss.source_id = ANY($1::uuid[]) AND s.enabled AND s.source_type IN ('pricing_page', 'release_notes')
      AND ss.interpretation_version >= 2 AND ss.interpretation_status = 'confirmed'
      AND length(btrim(ss.normalized_text)) > 0`, [ids]);
  const vectors = await db.rows<VectorRow>(client, `SELECT source_id,
      coalesce(document_id, snapshot_id) AS item_id,
      CASE WHEN document_id IS NULL THEN 'snapshot' ELSE 'document' END AS kind,
      chunk_no, content_version, text_content
    FROM marketrift.evidence_chunks WHERE source_id = ANY($1::uuid[])
      AND embedding_model = $2 AND embedding_version = $3 AND status = 'ready'`, [ids, model, version]);
  const controlled = await db.rows<CountRow>(client, `SELECT source_id, count(*)::integer AS count
    FROM marketrift.evidence_chunks WHERE source_id = ANY($1::uuid[])
      AND embedding_model = 'controlled-hash-TESTE' GROUP BY source_id`, [ids]);
  const active = new Map<string, Set<number>>();
  const itemByKey = new Map(items.map(item => [`${item.kind}:${item.item_id}`, item]));
  for (const vector of vectors) {
    const key = `${vector.kind}:${vector.item_id}`;
    const item = itemByKey.get(key);
    if (!item || item.content_version !== vector.content_version ||
      !item.text_content.includes(vector.text_content)) continue;
    if (!active.has(key)) active.set(key, new Set());
    active.get(key)!.add(vector.chunk_no);
  }
  const totals = new Map<string, { total: number; ready: number }>();
  for (const item of items) {
    const value = totals.get(item.source_id) ?? { total: 0, ready: 0 };
    const count = expectedChunkCount(item.text_content);
    value.total += count;
    const present = active.get(`${item.kind}:${item.item_id}`) ?? new Set<number>();
    for (let number = 0; number < count; number++) if (present.has(number)) value.ready++;
    totals.set(item.source_id, value);
  }
  const controlledCount = new Map(controlled.map(row => [row.source_id, row.count]));
  return sources.map(source => {
    const { total, ready } = totals.get(source.id) ?? { total: 0, ready: 0 };
    const state = !source.enabled ? 'disabled' : !total ? 'no_eligible_content' : !ready ?
      'not_indexed_for_model' : ready < total ? 'partial' : 'complete';
    return { source_id: source.id, source_type: source.source_type, state,
      total_chunks: total, ready_chunks: ready, controlled_test_chunks: controlledCount.get(source.id) ?? 0 };
  });
}
