-- Public GitHub Discussions are community conversations, never verified customer reviews.
BEGIN;
ALTER TABLE marketrift.sources DROP CONSTRAINT sources_source_type_check;
ALTER TABLE marketrift.sources ADD CONSTRAINT sources_source_type_check
  CHECK (source_type IN ('manual_review', 'github_issues', 'github_discussions', 'steam_reviews',
    'reclameaqui', 'g2', 'app_store', 'play_store', 'release_notes', 'pricing_page'));
ALTER TABLE marketrift.documents DROP CONSTRAINT documents_document_type_check;
ALTER TABLE marketrift.documents ADD CONSTRAINT documents_document_type_check
  CHECK (document_type IN ('review', 'release_note', 'github_issue', 'github_discussion', 'steam_review'));
ALTER TABLE marketrift.documents
  ADD COLUMN discussion_category text,
  ADD COLUMN discussion_author text,
  ADD COLUMN discussion_content_status text
    CHECK (discussion_content_status IN ('available', 'insufficient')),
  ADD COLUMN discussion_relevance text
    CHECK (discussion_relevance IN ('not_assessed', 'announcement')),
  ADD CONSTRAINT github_discussion_metadata_check CHECK
    (document_type <> 'github_discussion' OR
      (source_title IS NOT NULL AND source_repository IS NOT NULL AND
       discussion_category IS NOT NULL AND discussion_content_status IS NOT NULL AND
       discussion_relevance IS NOT NULL AND synthetic = false));
COMMIT;
