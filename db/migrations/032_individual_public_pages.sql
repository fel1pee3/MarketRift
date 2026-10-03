-- Opt-in capture of one reviewed public URL. No existing monitor is enabled.
BEGIN;
ALTER TABLE marketrift.sources DROP CONSTRAINT sources_source_type_check;
ALTER TABLE marketrift.sources ADD CONSTRAINT sources_source_type_check CHECK (source_type IN
  ('manual_review','b2b_csv_review','g2','github_issues','github_discussions',
   'steam_reviews','reclameaqui','app_store','play_store','release_notes','pricing_page',
   'rss_feed','public_page'));
CREATE TABLE marketrift.public_page_origins (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  source_id uuid NOT NULL,
  candidate_id uuid,
  feed_entry_id uuid,
  suggested_url text NOT NULL,
  confirmed_by uuid NOT NULL,
  confirmed_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((candidate_id IS NOT NULL) <> (feed_entry_id IS NOT NULL)),
  FOREIGN KEY (tenant_id,source_id) REFERENCES marketrift.sources(tenant_id,id),
  FOREIGN KEY (tenant_id,candidate_id) REFERENCES marketrift.discovery_candidates(tenant_id,id),
  FOREIGN KEY (tenant_id,feed_entry_id) REFERENCES marketrift.feed_entries(tenant_id,id),
  FOREIGN KEY (tenant_id,confirmed_by) REFERENCES marketrift.memberships(tenant_id,user_id)
);
CREATE UNIQUE INDEX public_page_origin_candidate ON marketrift.public_page_origins(tenant_id,source_id,candidate_id)
  WHERE candidate_id IS NOT NULL;
CREATE UNIQUE INDEX public_page_origin_feed ON marketrift.public_page_origins(tenant_id,source_id,feed_entry_id)
  WHERE feed_entry_id IS NOT NULL;
ALTER TABLE marketrift.public_page_origins ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketrift.public_page_origins FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON marketrift.public_page_origins TO marketrift_runtime
  USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT ON marketrift.public_page_origins TO marketrift_runtime;
COMMIT;
