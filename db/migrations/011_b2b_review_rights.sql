-- B2B reviews have a separate population and explicit rights metadata.
BEGIN;

ALTER TABLE marketrift.sources DROP CONSTRAINT sources_source_type_check;
ALTER TABLE marketrift.sources ADD CONSTRAINT sources_source_type_check CHECK (source_type IN
  ('manual_review', 'b2b_csv_review', 'g2', 'github_issues', 'github_discussions',
   'steam_reviews', 'reclameaqui', 'app_store', 'play_store', 'release_notes', 'pricing_page'));
ALTER TABLE marketrift.sources
  ADD COLUMN external_product_id text,
  ADD COLUMN access_environment text CHECK (access_environment IN ('sandbox', 'production')),
  ADD COLUMN access_status text NOT NULL DEFAULT 'not_assessed'
    CHECK (access_status IN ('not_assessed', 'pending', 'sandbox_only', 'authorized', 'denied')),
  ADD COLUMN rights_reference text,
  ADD COLUMN storage_permitted boolean NOT NULL DEFAULT false,
  ADD COLUMN external_ai_permitted boolean NOT NULL DEFAULT false,
  ADD COLUMN rights_attested_at timestamptz,
  ADD COLUMN rights_expires_at timestamptz,
  ADD CONSTRAINT review_rights_consistent CHECK
    (NOT external_ai_permitted OR (storage_permitted AND rights_reference IS NOT NULL)),
  ADD CONSTRAINT g2_source_identity CHECK
    (source_type <> 'g2' OR (external_product_id IS NOT NULL AND access_environment IS NOT NULL));

ALTER TABLE marketrift.documents DROP CONSTRAINT documents_document_type_check;
ALTER TABLE marketrift.documents ADD CONSTRAINT documents_document_type_check CHECK (document_type IN
  ('review', 'b2b_review', 'g2_review', 'release_note', 'github_issue', 'github_discussion', 'steam_review'));
ALTER TABLE marketrift.documents
  ADD COLUMN review_rating numeric(3,1) CHECK (review_rating BETWEEN 0 AND 5),
  ADD COLUMN review_data_status text CHECK (review_data_status IN
    ('synthetic_fixture', 'declared_real', 'sandbox_test', 'unverified_legacy')),
  ADD CONSTRAINT b2b_review_metadata_check CHECK
    (document_type NOT IN ('b2b_review', 'g2_review') OR
      (review_data_status IS NOT NULL AND
       ((review_data_status IN ('sandbox_test', 'synthetic_fixture') AND synthetic) OR
        (review_data_status = 'declared_real' AND NOT synthetic))));

ALTER TABLE marketrift.import_rows
  ADD COLUMN review_language text,
  ADD COLUMN review_rating numeric(3,1) CHECK (review_rating BETWEEN 0 AND 5);

-- Historical CSV rows lacked an explicit rights declaration. Preserve them,
-- but do not silently promote non-synthetic legacy data to authorized B2B data.
UPDATE marketrift.documents SET review_data_status = CASE
  WHEN synthetic THEN 'synthetic_fixture' ELSE 'unverified_legacy' END
WHERE document_type = 'review';

CREATE INDEX documents_b2b_origin ON marketrift.documents
  (tenant_id, source_id, external_key) WHERE document_type IN ('b2b_review', 'g2_review');
COMMIT;
