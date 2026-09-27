-- Versioned interpretation history and bounded structural markup for future reassessment.
BEGIN;
ALTER TABLE marketrift.source_snapshots
  ADD COLUMN reparse_markup text,
  ADD COLUMN markup_observed_at timestamptz,
  ADD COLUMN capture_complete boolean NOT NULL DEFAULT true,
  ADD COLUMN capture_limit_kind text CHECK (capture_limit_kind IN ('content_length', 'actual_bytes'));

CREATE TABLE marketrift.snapshot_interpretations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  source_id uuid NOT NULL,
  snapshot_id uuid NOT NULL,
  rule_version integer NOT NULL CHECK (rule_version > 0),
  status text NOT NULL CHECK (status IN ('pending','running','completed','blocked','failed')),
  interpretation_status text CHECK (interpretation_status IN ('confirmed','partial','unconfirmed','needs_review')),
  reason text NOT NULL,
  extracted jsonb,
  basis text NOT NULL CHECK (basis IN ('initial_capture','stored_markup','later_same_text_capture','historical_text_only')),
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, snapshot_id, rule_version),
  FOREIGN KEY (tenant_id, source_id) REFERENCES marketrift.sources (tenant_id, id),
  FOREIGN KEY (tenant_id, snapshot_id) REFERENCES marketrift.source_snapshots (tenant_id, id)
);
CREATE INDEX snapshot_interpretations_source ON marketrift.snapshot_interpretations
  (tenant_id, source_id, created_at DESC);
ALTER TABLE marketrift.snapshot_interpretations ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketrift.snapshot_interpretations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON marketrift.snapshot_interpretations TO marketrift_runtime
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON marketrift.snapshot_interpretations TO marketrift_runtime;

-- Existing rows retain their exact JSON and rule version. No old HTML is invented.
INSERT INTO marketrift.snapshot_interpretations
  (tenant_id,source_id,snapshot_id,rule_version,status,interpretation_status,reason,extracted,basis,
   created_at,finished_at)
SELECT tenant_id,source_id,id,coalesce(interpretation_version,1),'completed',interpretation_status,
  interpretation_reason,extracted,'initial_capture',fetched_at,fetched_at
FROM marketrift.source_snapshots WHERE extracted IS NOT NULL AND version_no IS NOT NULL;
COMMIT;
