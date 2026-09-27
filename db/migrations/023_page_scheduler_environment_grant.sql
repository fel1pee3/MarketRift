-- The page dispatcher filters sandbox sources; it needs this column to read them safely.
-- Keep the existing source/run RLS policies and column-scoped grants unchanged.
BEGIN;
GRANT SELECT (access_environment) ON marketrift.sources TO marketrift_provisioner;
COMMIT;
