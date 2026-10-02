-- Opt-in, metadata-only RSS/Atom monitoring. Existing sources remain paused.
BEGIN;
ALTER TABLE marketrift.sources DROP CONSTRAINT sources_source_type_check;
ALTER TABLE marketrift.sources ADD CONSTRAINT sources_source_type_check CHECK (source_type IN
  ('manual_review','b2b_csv_review','g2','github_issues','github_discussions',
   'steam_reviews','reclameaqui','app_store','play_store','release_notes','pricing_page','rss_feed'));
ALTER TABLE marketrift.source_runs DROP CONSTRAINT source_runs_run_kind_check;
ALTER TABLE marketrift.source_runs ADD CONSTRAINT source_runs_run_kind_check
  CHECK (run_kind IN ('connector','web_page','feed'));
ALTER TABLE marketrift.sources ADD COLUMN feed_monitor_generation integer NOT NULL DEFAULT 1
  CHECK (feed_monitor_generation > 0), ADD COLUMN feed_etag text,
  ADD COLUMN feed_last_modified text;
ALTER TABLE marketrift.source_runs ADD COLUMN feed_monitor_generation integer;
ALTER TABLE marketrift.sources ADD CONSTRAINT feed_monitor_interval CHECK (
  source_type <> 'rss_feed' OR NOT monitoring_enabled OR
  (check_interval_minutes IN (360,1440,10080) AND next_check_at IS NOT NULL));
CREATE FUNCTION marketrift.bump_feed_monitor_generation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.source_type = 'rss_feed' AND
     (NEW.url,NEW.product_id,NEW.enabled,NEW.monitoring_enabled,NEW.check_interval_minutes)
       IS DISTINCT FROM
     (OLD.url,OLD.product_id,OLD.enabled,OLD.monitoring_enabled,OLD.check_interval_minutes) THEN
    NEW.feed_monitor_generation := OLD.feed_monitor_generation + 1;
    IF NEW.url IS DISTINCT FROM OLD.url THEN
      NEW.feed_etag := NULL;
      NEW.feed_last_modified := NULL;
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER feed_monitor_revision BEFORE UPDATE OF url,product_id,enabled,
  monitoring_enabled,check_interval_minutes ON marketrift.sources
  FOR EACH ROW EXECUTE FUNCTION marketrift.bump_feed_monitor_generation();

CREATE TABLE marketrift.feed_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL,
  source_id uuid NOT NULL, external_id text NOT NULL,
  canonical_url text NOT NULL, title text NOT NULL,
  date_literal text, published_at timestamptz,
  content_sha256 char(64) NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  version_no integer NOT NULL DEFAULT 1 CHECK (version_no > 0),
  first_seen_at timestamptz NOT NULL DEFAULT now(), last_seen_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,id), UNIQUE (tenant_id,source_id,external_id),
  FOREIGN KEY (tenant_id,source_id) REFERENCES marketrift.sources (tenant_id,id)
);
CREATE TABLE marketrift.feed_entry_versions (
  tenant_id uuid NOT NULL, entry_id uuid NOT NULL, version_no integer NOT NULL,
  canonical_url text NOT NULL, title text NOT NULL, date_literal text,
  published_at timestamptz, content_sha256 char(64) NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,entry_id,version_no),
  FOREIGN KEY (tenant_id,entry_id) REFERENCES marketrift.feed_entries (tenant_id,id)
);
CREATE INDEX feed_entries_source_date ON marketrift.feed_entries (tenant_id,source_id,first_seen_at DESC);
CREATE UNIQUE INDEX source_runs_one_active_feed ON marketrift.source_runs (tenant_id,source_id)
  WHERE run_kind='feed' AND status IN ('pending','running');
CREATE INDEX sources_due_feed ON marketrift.sources(next_check_at,id)
  WHERE source_type='rss_feed' AND monitoring_enabled AND enabled;
ALTER TABLE marketrift.feed_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketrift.feed_entries FORCE ROW LEVEL SECURITY;
ALTER TABLE marketrift.feed_entry_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketrift.feed_entry_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON marketrift.feed_entries TO marketrift_runtime
  USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY tenant_scope ON marketrift.feed_entry_versions TO marketrift_runtime
  USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE,DELETE ON marketrift.feed_entries,marketrift.feed_entry_versions TO marketrift_runtime;
CREATE POLICY scheduler_feed_sources ON marketrift.sources TO marketrift_provisioner
  USING (source_type='rss_feed') WITH CHECK (source_type='rss_feed');
CREATE POLICY scheduler_feed_runs ON marketrift.source_runs TO marketrift_provisioner
  USING (run_kind='feed' AND EXISTS (SELECT 1 FROM marketrift.sources s
    WHERE s.tenant_id=source_runs.tenant_id AND s.id=source_runs.source_id AND s.source_type='rss_feed'))
  WITH CHECK (run_kind='feed' AND trigger_kind='scheduled' AND EXISTS
    (SELECT 1 FROM marketrift.sources s WHERE s.tenant_id=source_runs.tenant_id
      AND s.id=source_runs.source_id AND s.source_type='rss_feed'));
GRANT SELECT (feed_monitor_generation) ON marketrift.sources TO marketrift_provisioner;
GRANT SELECT (feed_monitor_generation) ON marketrift.source_runs TO marketrift_provisioner;
GRANT INSERT (feed_monitor_generation) ON marketrift.source_runs TO marketrift_provisioner;
COMMIT;
