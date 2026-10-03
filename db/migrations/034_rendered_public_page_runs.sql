BEGIN;

ALTER TABLE marketrift.source_runs
  ADD COLUMN capture_mode text NOT NULL DEFAULT 'static'
  CHECK (capture_mode IN ('static', 'rendered_dom'));

-- Scheduled checks and all existing runs retain the static collector.
GRANT SELECT (capture_mode) ON marketrift.source_runs TO marketrift_provisioner;

COMMIT;
