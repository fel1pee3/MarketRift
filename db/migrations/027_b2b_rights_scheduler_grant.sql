-- The existing scheduler may locate B2B deletion requests, but writes occur only
-- through marketrift_runtime with an explicit tenant transaction and source lock.
BEGIN;
CREATE POLICY scheduler_b2b_rights_sources ON marketrift.sources TO marketrift_provisioner
  USING (source_type='b2b_csv_review');
GRANT SELECT (b2b_retention_policy,b2b_deletion_status,b2b_deletion_next_attempt_at,
  b2b_deletion_requested_at,rights_expires_at) ON marketrift.sources TO marketrift_provisioner;
COMMIT;
