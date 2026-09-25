-- Conservative interpretation v2 and durable page monitoring. Apply after 008.
BEGIN;

ALTER TABLE marketrift.sources
  ADD COLUMN monitoring_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN next_check_at timestamptz,
  ADD COLUMN consecutive_failures integer NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  ADD CONSTRAINT page_monitoring_schedule_check CHECK (NOT monitoring_enabled OR next_check_at IS NOT NULL);
CREATE INDEX sources_due_page_checks ON marketrift.sources (next_check_at, id)
  WHERE monitoring_enabled AND enabled AND source_type IN ('pricing_page', 'release_notes');

ALTER TABLE marketrift.source_runs
  ADD COLUMN trigger_kind text NOT NULL DEFAULT 'manual'
    CHECK (trigger_kind IN ('manual', 'scheduled'));
CREATE INDEX source_runs_page_pending_recovery ON marketrift.source_runs (started_at, id)
  WHERE run_kind = 'web_page' AND status = 'pending';

-- Existing JSON is historical evidence. Its older interpretation is not silently promoted.
ALTER TABLE marketrift.source_snapshots
  ADD COLUMN interpretation_version integer,
  ADD COLUMN interpretation_status text NOT NULL DEFAULT 'needs_review'
    CHECK (interpretation_status IN ('confirmed', 'partial', 'unconfirmed', 'needs_review')),
  ADD COLUMN interpretation_reason text NOT NULL DEFAULT 'legacy_extractor_requires_review';

-- The scheduler reuses the existing provisioning connection, but receives only the
-- source/run columns needed to claim page checks. Tenant runtime policies remain intact.
CREATE POLICY scheduler_page_sources ON marketrift.sources TO marketrift_provisioner
  USING (source_type IN ('pricing_page', 'release_notes'))
  WITH CHECK (source_type IN ('pricing_page', 'release_notes'));
CREATE POLICY scheduler_page_runs ON marketrift.source_runs TO marketrift_provisioner
  USING (run_kind = 'web_page') WITH CHECK (run_kind = 'web_page');
GRANT SELECT (id, tenant_id, product_id, source_type, url, enabled,
  monitoring_enabled, next_check_at, check_interval_minutes, consecutive_failures,
  last_checked_at) ON marketrift.sources TO marketrift_provisioner;
GRANT UPDATE (next_check_at, consecutive_failures) ON marketrift.sources TO marketrift_provisioner;
GRANT SELECT (id, tenant_id, source_id, run_kind, trigger_kind, status,
  retry_after_at, started_at, finished_at) ON marketrift.source_runs TO marketrift_provisioner;
GRANT INSERT (tenant_id, source_id, status, run_kind, trigger_kind)
  ON marketrift.source_runs TO marketrift_provisioner;
GRANT UPDATE (status, error_code, finished_at) ON marketrift.source_runs TO marketrift_provisioner;

COMMIT;
