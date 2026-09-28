-- GitHub monitoring is opt-in. Existing and new sources stay paused.
BEGIN;

ALTER TABLE marketrift.sources ADD COLUMN github_monitor_generation integer NOT NULL DEFAULT 1
  CHECK (github_monitor_generation > 0);
ALTER TABLE marketrift.source_runs ADD COLUMN github_monitor_generation integer;
ALTER TABLE marketrift.sources ADD CONSTRAINT github_monitor_interval CHECK (
  source_type NOT IN ('github_issues', 'github_discussions') OR NOT monitoring_enabled
  OR (check_interval_minutes IN (360, 1440, 10080) AND next_check_at IS NOT NULL));

CREATE FUNCTION marketrift.bump_github_monitor_generation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.source_type IN ('github_issues', 'github_discussions') AND
     (NEW.url, NEW.product_id, NEW.enabled, NEW.monitoring_enabled, NEW.check_interval_minutes)
       IS DISTINCT FROM
     (OLD.url, OLD.product_id, OLD.enabled, OLD.monitoring_enabled, OLD.check_interval_minutes) THEN
    NEW.github_monitor_generation := OLD.github_monitor_generation + 1;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER github_monitor_revision BEFORE UPDATE OF url, product_id, enabled,
  monitoring_enabled, check_interval_minutes ON marketrift.sources
  FOR EACH ROW EXECUTE FUNCTION marketrift.bump_github_monitor_generation();

CREATE INDEX sources_due_github_monitor ON marketrift.sources(next_check_at, id)
  WHERE monitoring_enabled AND enabled AND source_type IN ('github_issues','github_discussions');
CREATE INDEX source_runs_github_pending ON marketrift.source_runs(started_at, id)
  WHERE run_kind='connector' AND trigger_kind='scheduled' AND status='pending';

-- The provisioner may dispatch only bounded GitHub runs. Runtime writes still use tenant RLS.
CREATE POLICY scheduler_github_sources ON marketrift.sources TO marketrift_provisioner
  USING (source_type IN ('github_issues','github_discussions'));
CREATE POLICY scheduler_github_runs ON marketrift.source_runs TO marketrift_provisioner
  USING (run_kind='connector' AND max_pages IS NOT NULL AND EXISTS
    (SELECT 1 FROM marketrift.sources s WHERE s.tenant_id=source_runs.tenant_id
      AND s.id=source_runs.source_id AND s.source_type IN ('github_issues','github_discussions')))
  WITH CHECK (run_kind='connector' AND trigger_kind='scheduled' AND max_pages IS NOT NULL
    AND EXISTS (SELECT 1 FROM marketrift.sources s WHERE s.tenant_id=source_runs.tenant_id
      AND s.id=source_runs.source_id AND s.source_type IN ('github_issues','github_discussions')));
GRANT SELECT (github_monitor_generation) ON marketrift.sources TO marketrift_provisioner;
GRANT SELECT (cursor_after, scan_complete, max_pages, max_items, github_monitor_generation)
  ON marketrift.source_runs TO marketrift_provisioner;
GRANT INSERT (cursor_before, max_pages, max_items, github_monitor_generation)
  ON marketrift.source_runs TO marketrift_provisioner;

COMMIT;
