-- A skipped feed job is not a collection failure. Preserve its run and reason.
BEGIN;
ALTER TABLE marketrift.source_runs DROP CONSTRAINT source_runs_status_check;
ALTER TABLE marketrift.source_runs ADD CONSTRAINT source_runs_status_check
  CHECK (status IN ('pending','running','succeeded','failed','cancelled'));
COMMIT;
