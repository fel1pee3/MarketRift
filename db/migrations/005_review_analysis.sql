-- Versioned, tenant-scoped review analyses and multiple evidenced issues per document.
BEGIN;

CREATE TABLE marketrift.document_analyses (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    document_id uuid NOT NULL,
    extractor_version text NOT NULL CHECK (length(btrim(extractor_version)) > 0),
    model_id text,
    prompt_version text,
    schema_version text,
    taxonomy_version text,
    status text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'unavailable')),
    attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    last_error text,
    queued_at timestamptz NOT NULL DEFAULT now(),
    started_at timestamptz,
    completed_at timestamptz,
    UNIQUE (tenant_id, id),
    UNIQUE (tenant_id, document_id, extractor_version),
    FOREIGN KEY (tenant_id, document_id)
        REFERENCES marketrift.documents (tenant_id, id) ON DELETE CASCADE
);

ALTER TABLE marketrift.insights
    DROP CONSTRAINT insights_tenant_id_document_id_extractor_version_key;
ALTER TABLE marketrift.insights
    ADD COLUMN analysis_id uuid,
    ADD COLUMN issue_index integer,
    ADD CONSTRAINT insights_analysis_fk FOREIGN KEY (tenant_id, analysis_id)
        REFERENCES marketrift.document_analyses (tenant_id, id) ON DELETE CASCADE,
    ADD CONSTRAINT insights_analyzed_issue_check CHECK (
        analysis_id IS NULL OR
        (issue_index >= 0 AND pain_point IS NOT NULL AND length(btrim(pain_point)) > 0
         AND severity IS NOT NULL AND evidence_quote IS NOT NULL
         AND length(btrim(evidence_quote)) > 0)
    );
CREATE UNIQUE INDEX insights_analysis_issue_unique
    ON marketrift.insights (tenant_id, analysis_id, issue_index);
CREATE INDEX document_analyses_tenant_status
    ON marketrift.document_analyses (tenant_id, status, queued_at);

ALTER TABLE marketrift.document_analyses ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketrift.document_analyses FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON marketrift.document_analyses TO marketrift_runtime
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON marketrift.document_analyses TO marketrift_runtime;

COMMIT;
