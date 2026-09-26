-- Keep bounded discovery diagnostics without storing response bodies or headers.
BEGIN;
ALTER TABLE marketrift.discovery_runs
  ADD COLUMN partial boolean NOT NULL DEFAULT false,
  ADD COLUMN resource_failures jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(resource_failures) = 'array');
COMMIT;
