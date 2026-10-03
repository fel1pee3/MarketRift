BEGIN;

ALTER TABLE marketrift.products ADD COLUMN usage_classification text NOT NULL DEFAULT 'unreviewed'
  CHECK (usage_classification IN ('unreviewed','real','test'));
ALTER TABLE marketrift.sources ADD COLUMN usage_classification text NOT NULL DEFAULT 'unreviewed'
  CHECK (usage_classification IN ('unreviewed','real','test'));

-- Historical discovery runs have no reliable provenance marker. Keep them in
-- advanced administration until a new run records its environment explicitly.
ALTER TABLE marketrift.discovery_runs ADD COLUMN test_data boolean;
ALTER TABLE marketrift.discovery_candidates ADD COLUMN test_data boolean;

COMMIT;
