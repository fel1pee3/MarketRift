-- Searchable, tenant-scoped excerpts. Applied after 012; no backfill in migration.
BEGIN;
CREATE TABLE marketrift.evidence_chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  source_id uuid NOT NULL,
  product_id uuid NOT NULL,
  document_id uuid,
  snapshot_id uuid,
  source_type text NOT NULL,
  chunk_no integer NOT NULL CHECK (chunk_no >= 0),
  content_version text NOT NULL,
  text_content text NOT NULL CHECK (length(btrim(text_content)) > 0),
  content_sha256 char(64) NOT NULL,
  embedding_model text NOT NULL,
  embedding_version text NOT NULL,
  embedding_dimensions integer NOT NULL DEFAULT 384 CHECK (embedding_dimensions = 384),
  status text NOT NULL DEFAULT 'ready' CHECK (status IN ('ready', 'stale')),
  synthetic boolean NOT NULL DEFAULT false,
  embedding vector(384) NOT NULL,
  indexed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  CHECK ((document_id IS NULL) <> (snapshot_id IS NULL)),
  FOREIGN KEY (tenant_id, source_id) REFERENCES marketrift.sources (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, product_id) REFERENCES marketrift.products (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, document_id) REFERENCES marketrift.documents (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, snapshot_id) REFERENCES marketrift.source_snapshots (tenant_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX evidence_chunks_document_unique ON marketrift.evidence_chunks
  (tenant_id, document_id, chunk_no, embedding_model, embedding_version) WHERE document_id IS NOT NULL;
CREATE UNIQUE INDEX evidence_chunks_snapshot_unique ON marketrift.evidence_chunks
  (tenant_id, snapshot_id, chunk_no, embedding_model, embedding_version) WHERE snapshot_id IS NOT NULL;
CREATE INDEX evidence_chunks_scope ON marketrift.evidence_chunks (tenant_id, source_type, product_id, synthetic);
CREATE INDEX evidence_chunks_source ON marketrift.evidence_chunks (tenant_id, source_id);
ALTER TABLE marketrift.evidence_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketrift.evidence_chunks FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON marketrift.evidence_chunks TO marketrift_runtime
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON marketrift.evidence_chunks TO marketrift_runtime;
COMMIT;
