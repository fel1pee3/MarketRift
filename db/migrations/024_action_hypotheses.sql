-- Human-authored hypotheses tied to an approved, versioned reviewable signal.
BEGIN;

ALTER TABLE marketrift.product_capabilities ADD COLUMN reviewed_by uuid;
ALTER TABLE marketrift.product_capabilities ADD CONSTRAINT capability_reviewer_membership
  FOREIGN KEY (tenant_id, reviewed_by) REFERENCES marketrift.memberships (tenant_id, user_id)
  ON DELETE SET NULL (reviewed_by);
CREATE UNIQUE INDEX product_capability_claim_once ON marketrift.product_capabilities
  (tenant_id, product_id, topic_id, claim);

CREATE TABLE marketrift.action_hypotheses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  signal_id uuid NOT NULL,
  signal_fact_key char(64) NOT NULL,
  signal_evidence_hash char(64) NOT NULL,
  signal_rule_version text NOT NULL,
  hypothesis_kind text NOT NULL CHECK (hypothesis_kind IN ('product', 'marketing')),
  facts jsonb NOT NULL CHECK (jsonb_typeof(facts) = 'array'),
  source_type text NOT NULL,
  coverage_note text NOT NULL,
  interpretation text NOT NULL CHECK (length(btrim(interpretation)) BETWEEN 10 AND 2000),
  proposed_action text NOT NULL CHECK (length(btrim(proposed_action)) BETWEEN 10 AND 2000),
  unverified_claims text NOT NULL CHECK (length(btrim(unverified_claims)) BETWEEN 5 AND 2000),
  verification_steps text NOT NULL CHECK (length(btrim(verification_steps)) BETWEEN 10 AND 2000),
  risks text NOT NULL DEFAULT '',
  own_capability_id uuid,
  own_advantage_claim text,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'proposed', 'approved', 'rejected', 'needs_review')),
  author_user_id uuid,
  reviewer_user_id uuid,
  review_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  submitted_at timestamptz,
  reviewed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, signal_id, signal_fact_key),
  FOREIGN KEY (tenant_id, signal_id) REFERENCES marketrift.reviewable_signals (tenant_id, id),
  FOREIGN KEY (tenant_id, own_capability_id) REFERENCES marketrift.product_capabilities (tenant_id, id),
  FOREIGN KEY (tenant_id, author_user_id) REFERENCES marketrift.memberships (tenant_id, user_id)
    ON DELETE SET NULL (author_user_id),
  FOREIGN KEY (tenant_id, reviewer_user_id) REFERENCES marketrift.memberships (tenant_id, user_id)
    ON DELETE SET NULL (reviewer_user_id),
  CHECK ((own_capability_id IS NULL) = (own_advantage_claim IS NULL))
);
CREATE INDEX action_hypotheses_by_status ON marketrift.action_hypotheses
  (tenant_id, status, created_at DESC);
ALTER TABLE marketrift.action_hypotheses ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketrift.action_hypotheses FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON marketrift.action_hypotheses TO marketrift_runtime
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON marketrift.action_hypotheses TO marketrift_runtime;

CREATE TABLE marketrift.action_hypothesis_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  hypothesis_id uuid NOT NULL,
  actor_user_id uuid,
  action text NOT NULL CHECK (action IN ('created', 'submitted', 'approved', 'rejected', 'signal_obsolete')),
  from_status text,
  to_status text NOT NULL,
  reason text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, hypothesis_id) REFERENCES marketrift.action_hypotheses (tenant_id, id)
    ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, actor_user_id) REFERENCES marketrift.memberships (tenant_id, user_id)
    ON DELETE SET NULL (actor_user_id)
);
CREATE INDEX action_hypothesis_events_history ON marketrift.action_hypothesis_events
  (tenant_id, hypothesis_id, occurred_at, id);
ALTER TABLE marketrift.action_hypothesis_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketrift.action_hypothesis_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON marketrift.action_hypothesis_events TO marketrift_runtime
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT ON marketrift.action_hypothesis_events TO marketrift_runtime;

-- This runs in the same transaction as reconciliation. The old fact's text is
-- withdrawn and an approved hypothesis immediately leaves the current list.
CREATE FUNCTION marketrift.withdraw_obsolete_hypotheses() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE h_record record;
BEGIN
  IF NEW.state = 'obsolete' AND OLD.state <> 'obsolete' THEN
    FOR h_record IN SELECT id, status FROM marketrift.action_hypotheses
      WHERE tenant_id = NEW.tenant_id AND signal_id = NEW.id AND status <> 'needs_review'
      FOR UPDATE LOOP
      UPDATE marketrift.action_hypotheses h
      SET status = 'needs_review', facts = '[]'::jsonb,
          review_reason = 'O sinal de origem perdeu suporte; confira a nova evidência.',
          updated_at = now()
      WHERE h.tenant_id = NEW.tenant_id AND h.id = h_record.id;
      INSERT INTO marketrift.action_hypothesis_events
        (tenant_id, hypothesis_id, action, from_status, to_status, reason)
      VALUES (NEW.tenant_id, h_record.id, 'signal_obsolete', h_record.status,
        'needs_review', 'O sinal de origem perdeu suporte');
    END LOOP;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER hypothesis_signal_obsolete AFTER UPDATE OF state ON marketrift.reviewable_signals
  FOR EACH ROW EXECUTE FUNCTION marketrift.withdraw_obsolete_hypotheses();
COMMIT;
