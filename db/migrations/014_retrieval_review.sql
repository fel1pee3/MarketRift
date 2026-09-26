-- Frozen, tenant-scoped human judgments of public GitHub evidence.
BEGIN;
CREATE TABLE marketrift.retrieval_sets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES marketrift.tenants(id),
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 3 AND 120),
  product_id uuid,
  period_from date,
  period_to date,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  parent_set_id uuid,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'frozen')),
  corpus_hash char(64),
  created_by uuid NOT NULL REFERENCES marketrift.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  frozen_at timestamptz,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, product_id) REFERENCES marketrift.products(tenant_id, id),
  FOREIGN KEY (tenant_id, parent_set_id) REFERENCES marketrift.retrieval_sets(tenant_id, id),
  CHECK (period_from IS NULL OR period_to IS NULL OR period_from <= period_to)
);
CREATE TABLE marketrift.retrieval_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  set_id uuid NOT NULL,
  document_id uuid NOT NULL, -- no FK: a removed source must be visible as stale
  chunk_id uuid NOT NULL,
  source_id uuid NOT NULL,
  product_id uuid NOT NULL,
  source_type text NOT NULL CHECK (source_type IN ('github_issue', 'github_discussion')),
  origin_key text NOT NULL,
  source_url text NOT NULL,
  observed_at timestamptz NOT NULL,
  text_content text NOT NULL,
  text_hash char(64) NOT NULL,
  content_version text NOT NULL,
  chunk_no integer NOT NULL,
  source_partial boolean NOT NULL,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, set_id, origin_key, chunk_no),
  FOREIGN KEY (tenant_id, set_id) REFERENCES marketrift.retrieval_sets(tenant_id, id) ON DELETE CASCADE
);
CREATE TABLE marketrift.retrieval_questions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  set_id uuid NOT NULL,
  text_content text NOT NULL CHECK (length(btrim(text_content)) BETWEEN 3 AND 500),
  language text NOT NULL CHECK (language IN ('pt', 'en')),
  no_answer_claim boolean NOT NULL DEFAULT false,
  created_by uuid NOT NULL REFERENCES marketrift.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, set_id, id),
  FOREIGN KEY (tenant_id, set_id) REFERENCES marketrift.retrieval_sets(tenant_id, id) ON DELETE CASCADE
);
CREATE TABLE marketrift.retrieval_judgments (
  tenant_id uuid NOT NULL,
  set_id uuid NOT NULL,
  question_id uuid NOT NULL,
  item_id uuid NOT NULL,
  verdict text NOT NULL CHECK (verdict IN ('relevant', 'irrelevant')),
  reviewer_id uuid NOT NULL REFERENCES marketrift.users(id),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  judged_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, question_id, item_id),
  FOREIGN KEY (tenant_id, set_id) REFERENCES marketrift.retrieval_sets(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, set_id, question_id) REFERENCES marketrift.retrieval_questions(tenant_id, set_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, item_id) REFERENCES marketrift.retrieval_items(tenant_id, id) ON DELETE CASCADE
);
CREATE TABLE marketrift.retrieval_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  set_id uuid NOT NULL,
  corpus_hash char(64) NOT NULL,
  judgment_hash char(64) NOT NULL,
  result jsonb NOT NULL,
  created_by uuid NOT NULL REFERENCES marketrift.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, set_id) REFERENCES marketrift.retrieval_sets(tenant_id, id) ON DELETE CASCADE
);
DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['retrieval_sets', 'retrieval_items', 'retrieval_questions',
      'retrieval_judgments', 'retrieval_reports'] LOOP
    EXECUTE format('ALTER TABLE marketrift.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE marketrift.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY tenant_scope ON marketrift.%I TO marketrift_runtime USING '
      || '(tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK '
      || '(tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)', table_name);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON marketrift.%I TO marketrift_runtime', table_name);
  END LOOP;
END $$;
COMMIT;
