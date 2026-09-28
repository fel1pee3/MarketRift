-- Explicit retention declaration and durable B2B text deletion. No source is purged by this migration.
BEGIN;

ALTER TABLE marketrift.sources
  ADD COLUMN b2b_retention_policy text NOT NULL DEFAULT 'unspecified'
    CHECK (b2b_retention_policy IN ('unspecified', 'retain_after_expiry', 'delete_on_expiry')),
  ADD COLUMN b2b_rights_generation integer NOT NULL DEFAULT 1 CHECK (b2b_rights_generation > 0),
  ADD COLUMN b2b_deletion_status text NOT NULL DEFAULT 'not_required'
    CHECK (b2b_deletion_status IN ('not_required', 'pending', 'failed', 'completed')),
  ADD COLUMN b2b_deletion_reason text CHECK (b2b_deletion_reason IN ('expiry', 'revocation')),
  ADD COLUMN b2b_deletion_requested_at timestamptz,
  ADD COLUMN b2b_deletion_completed_at timestamptz,
  ADD COLUMN b2b_deletion_next_attempt_at timestamptz,
  ADD COLUMN b2b_deletion_attempts integer NOT NULL DEFAULT 0 CHECK (b2b_deletion_attempts >= 0),
  ADD COLUMN b2b_deletion_error text,
  ADD COLUMN b2b_deleted_documents integer NOT NULL DEFAULT 0 CHECK (b2b_deleted_documents >= 0),
  ADD COLUMN b2b_deleted_import_rows integer NOT NULL DEFAULT 0 CHECK (b2b_deleted_import_rows >= 0);

ALTER TABLE marketrift.imports ADD COLUMN b2b_rights_generation integer;
UPDATE marketrift.imports i SET b2b_rights_generation=s.b2b_rights_generation
FROM marketrift.sources s WHERE i.tenant_id=s.tenant_id AND i.source_id=s.id
  AND s.source_type='b2b_csv_review';

ALTER TABLE marketrift.b2b_quality_sets DROP CONSTRAINT b2b_quality_sets_status_check;
ALTER TABLE marketrift.b2b_quality_sets ADD CONSTRAINT b2b_quality_sets_status_check
  CHECK (status IN ('draft', 'frozen', 'purged'));

CREATE TABLE marketrift.b2b_rights_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  source_id uuid NOT NULL,
  event_kind text NOT NULL CHECK (event_kind IN ('declared', 'renewed', 'revoked', 'deletion_completed', 'deletion_failed')),
  actor_user_id uuid REFERENCES marketrift.users(id),
  reference_sha256 char(64),
  retention_policy text NOT NULL,
  rights_expires_at timestamptz,
  documents_removed integer NOT NULL DEFAULT 0,
  import_rows_removed integer NOT NULL DEFAULT 0,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, source_id) REFERENCES marketrift.sources(tenant_id,id) ON DELETE CASCADE
);
CREATE INDEX b2b_rights_events_source ON marketrift.b2b_rights_events(tenant_id,source_id,created_at DESC);
CREATE INDEX b2b_rights_due ON marketrift.sources(b2b_deletion_next_attempt_at,rights_expires_at)
  WHERE source_type='b2b_csv_review' AND b2b_deletion_status <> 'completed';
ALTER TABLE marketrift.b2b_rights_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketrift.b2b_rights_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON marketrift.b2b_rights_events TO marketrift_runtime
  USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON marketrift.b2b_rights_events TO marketrift_runtime;
COMMIT;
