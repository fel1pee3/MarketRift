-- Public GitHub Issues are source documents, not customer reviews.
BEGIN;

ALTER TABLE marketrift.sources DROP CONSTRAINT sources_source_type_check;
ALTER TABLE marketrift.sources ADD CONSTRAINT sources_source_type_check
  CHECK (source_type IN ('manual_review', 'github_issues', 'reclameaqui', 'g2',
    'app_store', 'play_store', 'release_notes', 'pricing_page'));
ALTER TABLE marketrift.documents DROP CONSTRAINT documents_document_type_check;
ALTER TABLE marketrift.documents ADD CONSTRAINT documents_document_type_check
  CHECK (document_type IN ('review', 'release_note', 'github_issue'));
ALTER TABLE marketrift.documents
  ADD COLUMN source_title text,
  ADD COLUMN source_body text,
  ADD COLUMN source_created_at timestamptz,
  ADD COLUMN source_updated_at timestamptz,
  ADD COLUMN source_state text,
  ADD COLUMN source_repository text;
ALTER TABLE marketrift.source_runs
  ADD COLUMN max_pages integer CHECK (max_pages BETWEEN 1 AND 3),
  ADD COLUMN max_items integer CHECK (max_items BETWEEN 1 AND 50),
  ADD COLUMN pages_fetched integer NOT NULL DEFAULT 0 CHECK (pages_fetched >= 0),
  ADD COLUMN documents_updated integer NOT NULL DEFAULT 0 CHECK (documents_updated >= 0),
  ADD COLUMN pull_requests_skipped integer NOT NULL DEFAULT 0 CHECK (pull_requests_skipped >= 0),
  ADD COLUMN retry_after_at timestamptz;
CREATE UNIQUE INDEX source_runs_one_active_github
  ON marketrift.source_runs (tenant_id, source_id)
  WHERE status IN ('pending', 'running') AND max_pages IS NOT NULL;

COMMIT;
