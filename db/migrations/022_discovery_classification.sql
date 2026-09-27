-- Version the discovery heuristic and retain every changed suggestion.
BEGIN;
ALTER TABLE marketrift.discovery_candidates
  ADD COLUMN classification_version integer NOT NULL DEFAULT 1
  CHECK (classification_version > 0);
ALTER TABLE marketrift.discovery_candidates
  ADD COLUMN first_discovered_from_url text,
  ADD COLUMN first_discovery_method text;
UPDATE marketrift.discovery_candidates SET first_discovered_from_url=discovered_from_url,
  first_discovery_method=discovery_method;
ALTER TABLE marketrift.discovery_candidates
  ALTER COLUMN first_discovered_from_url SET NOT NULL,
  ALTER COLUMN first_discovery_method SET NOT NULL;

CREATE TABLE marketrift.discovery_classification_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  candidate_id uuid NOT NULL,
  previous_type text NOT NULL,
  current_type text NOT NULL,
  previous_category text NOT NULL,
  current_category text NOT NULL,
  previous_version integer NOT NULL,
  current_version integer NOT NULL,
  previous_status text NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, candidate_id)
    REFERENCES marketrift.discovery_candidates (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX discovery_classification_history_candidate
  ON marketrift.discovery_classification_history (tenant_id, candidate_id, changed_at DESC);
ALTER TABLE marketrift.discovery_classification_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketrift.discovery_classification_history FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON marketrift.discovery_classification_history TO marketrift_runtime
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT ON marketrift.discovery_classification_history TO marketrift_runtime;

CREATE FUNCTION marketrift.record_discovery_classification() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.suggested_type IS DISTINCT FROM NEW.suggested_type
     OR OLD.category IS DISTINCT FROM NEW.category
     OR OLD.classification_version IS DISTINCT FROM NEW.classification_version THEN
    INSERT INTO marketrift.discovery_classification_history
      (tenant_id,candidate_id,previous_type,current_type,previous_category,current_category,
       previous_version,current_version,previous_status)
    VALUES (NEW.tenant_id,NEW.id,OLD.suggested_type,NEW.suggested_type,OLD.category,NEW.category,
            OLD.classification_version,NEW.classification_version,OLD.status);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER discovery_classification_changed
  AFTER UPDATE OF suggested_type,category,classification_version
  ON marketrift.discovery_candidates FOR EACH ROW
  EXECUTE FUNCTION marketrift.record_discovery_classification();

-- Only unreviewed children of a changelog are repaired. Human decisions remain untouched.
UPDATE marketrift.discovery_candidates
SET suggested_type='changelog_entry',category='product',classification_version=2
WHERE status='pending' AND reviewed_at IS NULL AND linked_source_id IS NULL
  AND suggested_type IN ('pricing_page','release_notes')
  AND canonical_url ~* '^https://[^/]+/changelog/[^/?#]+';
COMMIT;
