BEGIN;
ALTER TABLE marketrift.retrieval_sets ADD COLUMN origin text NOT NULL DEFAULT 'public_real'
  CHECK (origin IN ('public_real', 'synthetic_test'));
COMMIT;
