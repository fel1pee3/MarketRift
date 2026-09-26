-- Reviewable, descriptive facts. Existing strategic market_signals remain untouched.
BEGIN;

CREATE TABLE marketrift.reviewable_signals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  fact_key char(64) NOT NULL CHECK (fact_key ~ '^[0-9a-f]{64}$'),
  rule_version text NOT NULL,
  signal_type text NOT NULL CHECK (signal_type IN
    ('price_change', 'release_entry', 'github_issue_activity', 'github_discussion_activity')),
  source_type text NOT NULL CHECK (source_type IN
    ('pricing_page', 'release_notes', 'github_issues', 'github_discussions')),
  state text NOT NULL DEFAULT 'candidate' CHECK (state IN ('candidate', 'approved', 'discarded', 'obsolete')),
  source_id uuid NOT NULL,
  summary text NOT NULL,
  interpretation_limit text NOT NULL,
  page_change_id uuid,
  previous_snapshot_id uuid,
  current_snapshot_id uuid,
  evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence) = 'object'),
  evidence_hash char(64) NOT NULL CHECK (evidence_hash ~ '^[0-9a-f]{64}$'),
  test_data boolean NOT NULL DEFAULT false,
  observed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  reviewed_by uuid,
  reviewed_at timestamptz,
  review_reason text,
  obsolete_reason text,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, fact_key),
  FOREIGN KEY (tenant_id, source_id) REFERENCES marketrift.sources (tenant_id, id),
  FOREIGN KEY (tenant_id, page_change_id) REFERENCES marketrift.page_changes (tenant_id, id),
  FOREIGN KEY (tenant_id, previous_snapshot_id) REFERENCES marketrift.source_snapshots (tenant_id, id),
  FOREIGN KEY (tenant_id, current_snapshot_id) REFERENCES marketrift.source_snapshots (tenant_id, id),
  FOREIGN KEY (tenant_id, reviewed_by) REFERENCES marketrift.memberships (tenant_id, user_id) ON DELETE SET NULL (reviewed_by),
  CHECK ((page_change_id IS NOT NULL AND previous_snapshot_id IS NOT NULL AND current_snapshot_id IS NOT NULL)
    = (signal_type IN ('price_change', 'release_entry')))
);
CREATE INDEX reviewable_signals_by_state ON marketrift.reviewable_signals (tenant_id, state, observed_at DESC);
ALTER TABLE marketrift.reviewable_signals ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketrift.reviewable_signals FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON marketrift.reviewable_signals TO marketrift_runtime
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON marketrift.reviewable_signals TO marketrift_runtime;

CREATE TABLE marketrift.signal_alert_reads (
  tenant_id uuid NOT NULL,
  signal_id uuid NOT NULL,
  user_id uuid NOT NULL,
  read_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, signal_id, user_id),
  FOREIGN KEY (tenant_id, signal_id) REFERENCES marketrift.reviewable_signals (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, user_id) REFERENCES marketrift.memberships (tenant_id, user_id) ON DELETE CASCADE
);
ALTER TABLE marketrift.signal_alert_reads ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketrift.signal_alert_reads FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON marketrift.signal_alert_reads TO marketrift_runtime
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON marketrift.signal_alert_reads TO marketrift_runtime;
COMMIT;
