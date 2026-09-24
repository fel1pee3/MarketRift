-- Steam user reviews: source evidence remains separate from AI classifications.
BEGIN;
ALTER TABLE marketrift.sources DROP CONSTRAINT sources_source_type_check;
ALTER TABLE marketrift.sources ADD CONSTRAINT sources_source_type_check
  CHECK (source_type IN ('manual_review', 'github_issues', 'steam_reviews', 'reclameaqui', 'g2',
    'app_store', 'play_store', 'release_notes', 'pricing_page'));
ALTER TABLE marketrift.documents DROP CONSTRAINT documents_document_type_check;
ALTER TABLE marketrift.documents ADD CONSTRAINT documents_document_type_check
  CHECK (document_type IN ('review', 'release_note', 'github_issue', 'steam_review'));
ALTER TABLE marketrift.documents
  ADD COLUMN steam_app_id bigint CHECK (steam_app_id BETWEEN 1 AND 4294967295),
  ADD COLUMN review_language text,
  ADD COLUMN review_voted_up boolean,
  ADD COLUMN source_url_kind text CHECK (source_url_kind IN ('product_reviews')),
  ADD CONSTRAINT steam_review_metadata_check CHECK
    (document_type <> 'steam_review' OR
      (steam_app_id IS NOT NULL AND review_language IS NOT NULL AND
       review_voted_up IS NOT NULL AND source_created_at IS NOT NULL AND
       source_updated_at IS NOT NULL AND source_url_kind = 'product_reviews' AND synthetic = false));
ALTER TABLE marketrift.source_runs
  ADD COLUMN documents_ignored integer NOT NULL DEFAULT 0 CHECK (documents_ignored >= 0),
  ADD COLUMN scan_complete boolean;
ALTER INDEX marketrift.source_runs_one_active_github RENAME TO source_runs_one_active_bounded;
CREATE INDEX documents_steam_review_identity
  ON marketrift.documents (tenant_id, steam_app_id, external_key)
  WHERE document_type = 'steam_review';
COMMIT;
