-- Manual, evidence-first monitoring of public pricing and changelog pages.
BEGIN;
ALTER TABLE marketrift.sources ADD COLUMN check_interval_minutes integer
  CHECK (check_interval_minutes IN (60, 360, 1440, 10080));
ALTER TABLE marketrift.source_runs ADD COLUMN run_kind text NOT NULL DEFAULT 'connector'
  CHECK (run_kind IN ('connector', 'web_page'));
CREATE UNIQUE INDEX source_runs_one_active_web_page ON marketrift.source_runs (tenant_id, source_id)
  WHERE run_kind = 'web_page' AND status IN ('pending', 'running');

ALTER TABLE marketrift.source_snapshots
  ADD COLUMN source_id uuid,
  ADD COLUMN version_no integer CHECK (version_no > 0),
  ADD COLUMN final_url text,
  ADD COLUMN normalized_text text,
  ADD COLUMN extracted jsonb;
UPDATE marketrift.source_snapshots ss SET source_id = sr.source_id
  FROM marketrift.source_runs sr WHERE sr.tenant_id = ss.tenant_id AND sr.id = ss.run_id;
ALTER TABLE marketrift.source_snapshots ALTER COLUMN source_id SET NOT NULL;
ALTER TABLE marketrift.source_snapshots ADD CONSTRAINT snapshots_source_tenant_fk
  FOREIGN KEY (tenant_id, source_id) REFERENCES marketrift.sources (tenant_id, id);
CREATE UNIQUE INDEX source_snapshots_page_version ON marketrift.source_snapshots (tenant_id, source_id, version_no)
  WHERE version_no IS NOT NULL;

CREATE TABLE marketrift.page_changes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  source_id uuid NOT NULL,
  previous_snapshot_id uuid NOT NULL,
  current_snapshot_id uuid NOT NULL,
  change_details jsonb NOT NULL CHECK (jsonb_typeof(change_details) = 'array'),
  detected_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, source_id, previous_snapshot_id, current_snapshot_id),
  FOREIGN KEY (tenant_id, source_id) REFERENCES marketrift.sources (tenant_id, id),
  FOREIGN KEY (tenant_id, previous_snapshot_id) REFERENCES marketrift.source_snapshots (tenant_id, id),
  FOREIGN KEY (tenant_id, current_snapshot_id) REFERENCES marketrift.source_snapshots (tenant_id, id)
);
ALTER TABLE marketrift.page_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketrift.page_changes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON marketrift.page_changes TO marketrift_runtime
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON marketrift.page_changes TO marketrift_runtime;
CREATE INDEX page_changes_by_source ON marketrift.page_changes (tenant_id, source_id, detected_at DESC);
COMMIT;
