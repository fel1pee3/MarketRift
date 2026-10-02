-- The feed scheduler filters cancelled/stale failures by error_code.
-- Grant only the column needed by the operational provisioner role.
BEGIN;
GRANT SELECT (error_code) ON marketrift.source_runs TO marketrift_provisioner;
COMMIT;
