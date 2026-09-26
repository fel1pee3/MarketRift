-- Durable, per-source reconciliation requests. No backfill: existing approved facts are untouched.
BEGIN;
CREATE TABLE marketrift.signal_reconcile_sources (
  tenant_id uuid NOT NULL,
  source_id uuid NOT NULL,
  requested_revision bigint NOT NULL DEFAULT 1 CHECK (requested_revision > 0),
  processed_revision bigint NOT NULL DEFAULT 0 CHECK (processed_revision >= 0),
  last_reconciled_at timestamptz,
  last_error text,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, source_id),
  FOREIGN KEY (tenant_id, source_id) REFERENCES marketrift.sources (tenant_id, id) ON DELETE CASCADE,
  CHECK (processed_revision <= requested_revision)
);
CREATE INDEX signal_reconcile_due ON marketrift.signal_reconcile_sources
  (next_attempt_at, updated_at) WHERE requested_revision > processed_revision;
ALTER TABLE marketrift.signal_reconcile_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketrift.signal_reconcile_sources FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON marketrift.signal_reconcile_sources TO marketrift_runtime
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY scheduler_scope ON marketrift.signal_reconcile_sources TO marketrift_provisioner
  USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE ON marketrift.signal_reconcile_sources TO marketrift_runtime;
GRANT SELECT, INSERT, UPDATE ON marketrift.signal_reconcile_sources TO marketrift_provisioner;

CREATE FUNCTION marketrift.request_signal_reconciliation() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_tenant uuid; v_source uuid; v_type text;
BEGIN
  v_tenant := COALESCE(NEW.tenant_id, OLD.tenant_id);
  v_source := COALESCE(NEW.source_id, OLD.source_id);
  SELECT source_type INTO v_type FROM marketrift.sources WHERE tenant_id=v_tenant AND id=v_source;
  IF v_type NOT IN ('github_issues','github_discussions','pricing_page','release_notes') THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  INSERT INTO marketrift.signal_reconcile_sources (tenant_id,source_id)
    VALUES (v_tenant,v_source)
  ON CONFLICT (tenant_id,source_id) DO UPDATE SET
    requested_revision=signal_reconcile_sources.requested_revision+1,
    next_attempt_at=now(), last_error=NULL, attempts=0, updated_at=now();
  RETURN COALESCE(NEW, OLD);
END $$;

CREATE FUNCTION marketrift.request_signal_reconciliation_for_source() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.source_type IN ('github_issues','github_discussions','pricing_page','release_notes')
     AND (OLD.enabled,OLD.product_id,OLD.url) IS DISTINCT FROM (NEW.enabled,NEW.product_id,NEW.url) THEN
    INSERT INTO marketrift.signal_reconcile_sources (tenant_id,source_id)
      VALUES (NEW.tenant_id,NEW.id)
    ON CONFLICT (tenant_id,source_id) DO UPDATE SET
      requested_revision=signal_reconcile_sources.requested_revision+1,
      next_attempt_at=now(), last_error=NULL, attempts=0, updated_at=now();
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER signal_run_committed AFTER UPDATE OF status ON marketrift.source_runs
  FOR EACH ROW WHEN (NEW.status='succeeded' AND OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION marketrift.request_signal_reconciliation();
CREATE TRIGGER signal_document_changed AFTER INSERT OR UPDATE OR DELETE ON marketrift.documents
  FOR EACH ROW EXECUTE FUNCTION marketrift.request_signal_reconciliation();
CREATE TRIGGER signal_page_changed AFTER INSERT OR UPDATE OR DELETE ON marketrift.page_changes
  FOR EACH ROW EXECUTE FUNCTION marketrift.request_signal_reconciliation();
CREATE TRIGGER signal_source_changed AFTER UPDATE OF enabled,product_id,url ON marketrift.sources
  FOR EACH ROW EXECUTE FUNCTION marketrift.request_signal_reconciliation_for_source();
COMMIT;
