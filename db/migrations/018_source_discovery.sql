-- Manual, bounded discovery of candidate sources. No existing source or signal is rewritten.
BEGIN;
CREATE TABLE marketrift.competitor_profiles (
  tenant_id uuid NOT NULL,
  product_id uuid NOT NULL,
  official_domain text NOT NULL CHECK (length(official_domain) BETWEEN 4 AND 253),
  aliases text[] NOT NULL DEFAULT '{}',
  country_code text CHECK (country_code ~ '^[A-Z]{2}$'),
  languages text[] NOT NULL DEFAULT '{}',
  official_urls text[] NOT NULL DEFAULT '{}',
  identity_version integer NOT NULL DEFAULT 1 CHECK (identity_version > 0),
  discovery_paused boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, product_id),
  FOREIGN KEY (tenant_id, product_id) REFERENCES marketrift.products (tenant_id, id)
);
CREATE TABLE marketrift.discovery_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  product_id uuid NOT NULL,
  identity_version integer NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','succeeded','failed')),
  error_code text,
  pages_examined integer NOT NULL DEFAULT 0,
  candidates_seen integer NOT NULL DEFAULT 0,
  candidates_new integer NOT NULL DEFAULT 0,
  retry_after_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, product_id) REFERENCES marketrift.competitor_profiles (tenant_id, product_id)
);
CREATE UNIQUE INDEX discovery_one_active_run ON marketrift.discovery_runs (tenant_id, product_id)
  WHERE status IN ('pending','running');
CREATE INDEX discovery_runs_recent ON marketrift.discovery_runs (tenant_id, product_id, created_at DESC);
CREATE TABLE marketrift.discovery_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  product_id uuid NOT NULL,
  canonical_url text NOT NULL,
  category text NOT NULL CHECK (category IN ('official_site','product','reviews','community','apps','social','news')),
  suggested_type text NOT NULL,
  discovered_from_url text NOT NULL,
  discovery_method text NOT NULL CHECK (discovery_method IN ('homepage','sitemap','feed','known_url')),
  association_evidence text NOT NULL,
  confidence text NOT NULL CHECK (confidence IN ('official_host','linked_external','ambiguous')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','rejected','access_unavailable','rights_pending')),
  linked_source_id uuid,
  identity_version integer NOT NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_examined_at timestamptz NOT NULL DEFAULT now(),
  reviewed_by uuid,
  reviewed_at timestamptz,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, product_id, canonical_url),
  FOREIGN KEY (tenant_id, product_id) REFERENCES marketrift.competitor_profiles (tenant_id, product_id),
  FOREIGN KEY (tenant_id, linked_source_id) REFERENCES marketrift.sources (tenant_id, id),
  FOREIGN KEY (tenant_id, reviewed_by) REFERENCES marketrift.memberships (tenant_id, user_id) ON DELETE SET NULL (reviewed_by)
);
CREATE INDEX discovery_candidates_by_product ON marketrift.discovery_candidates (tenant_id, product_id, status);
DO $$ DECLARE name text; BEGIN
  FOREACH name IN ARRAY ARRAY['competitor_profiles','discovery_runs','discovery_candidates'] LOOP
    EXECUTE format('ALTER TABLE marketrift.%I ENABLE ROW LEVEL SECURITY', name);
    EXECUTE format('ALTER TABLE marketrift.%I FORCE ROW LEVEL SECURITY', name);
    EXECUTE format('CREATE POLICY tenant_scope ON marketrift.%I TO marketrift_runtime USING '
      || '(tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK '
      || '(tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)', name);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON marketrift.%I TO marketrift_runtime', name);
  END LOOP;
END $$;
COMMIT;
