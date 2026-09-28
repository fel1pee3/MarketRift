-- Human B2B extraction judgments. Reviews remain only in documents; labels store offsets, not copied text.
BEGIN;

CREATE TABLE marketrift.b2b_quality_sets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES marketrift.tenants(id),
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 3 AND 120),
  origin text NOT NULL CHECK (origin IN ('real', 'synthetic_test')),
  product_id uuid,
  source_id uuid,
  period_from date,
  period_to date,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  parent_set_id uuid,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'frozen')),
  corpus_hash char(64),
  judgment_hash char(64),
  created_by uuid NOT NULL REFERENCES marketrift.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  frozen_at timestamptz,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, product_id) REFERENCES marketrift.products(tenant_id, id),
  FOREIGN KEY (tenant_id, source_id) REFERENCES marketrift.sources(tenant_id, id),
  FOREIGN KEY (tenant_id, parent_set_id) REFERENCES marketrift.b2b_quality_sets(tenant_id, id),
  CHECK (period_from IS NULL OR period_to IS NULL OR period_from <= period_to)
);

CREATE TABLE marketrift.b2b_quality_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  set_id uuid NOT NULL,
  document_id uuid NOT NULL, -- no FK: deletion must leave an invalid historical reference
  source_id uuid NOT NULL,
  content_hash char(64) NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  metadata_hash char(64) NOT NULL CHECK (metadata_hash ~ '^[0-9a-f]{64}$'),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, set_id, document_id),
  FOREIGN KEY (tenant_id, set_id) REFERENCES marketrift.b2b_quality_sets(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE marketrift.b2b_quality_labels (
  tenant_id uuid NOT NULL,
  set_id uuid NOT NULL,
  item_id uuid NOT NULL,
  decision text NOT NULL CHECK (decision IN ('problem', 'no_problem', 'insufficient_evidence')),
  -- [{category, severity, start, end}], validated against the current body by the API.
  issues jsonb NOT NULL CHECK (jsonb_typeof(issues) = 'array'),
  reviewer_id uuid NOT NULL REFERENCES marketrift.users(id),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  judged_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, set_id, item_id),
  FOREIGN KEY (tenant_id, set_id) REFERENCES marketrift.b2b_quality_sets(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, item_id) REFERENCES marketrift.b2b_quality_items(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE marketrift.b2b_quality_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  set_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('test', 'openai')),
  model text NOT NULL,
  status text NOT NULL CHECK (status IN ('reserved', 'completed', 'failed')),
  result jsonb,
  error_code text,
  created_by uuid NOT NULL REFERENCES marketrift.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, set_id, provider, model),
  FOREIGN KEY (tenant_id, set_id) REFERENCES marketrift.b2b_quality_sets(tenant_id, id) ON DELETE CASCADE
);

DO $$ DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['b2b_quality_sets', 'b2b_quality_items',
    'b2b_quality_labels', 'b2b_quality_reports'] LOOP
    EXECUTE format('ALTER TABLE marketrift.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE marketrift.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY tenant_scope ON marketrift.%I TO marketrift_runtime USING '
      || '(tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK '
      || '(tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)', table_name);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON marketrift.%I TO marketrift_runtime', table_name);
  END LOOP;
END $$;
COMMIT;
