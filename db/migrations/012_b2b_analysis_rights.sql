-- Separate permission to store B2B reviews from permission to send them to external AI.
BEGIN;

ALTER TABLE marketrift.sources
  ADD COLUMN ai_rights_reference text,
  ADD COLUMN ai_provider text CHECK (ai_provider IN ('openai')),
  ADD COLUMN ai_rights_attested_at timestamptz,
  ADD COLUMN ai_rights_expires_at timestamptz,
  ADD COLUMN ai_rights_revoked_at timestamptz,
  ADD CONSTRAINT b2b_external_ai_rights_check CHECK (
    source_type <> 'b2b_csv_review' OR NOT external_ai_permitted OR
    (access_environment = 'production' AND storage_permitted AND
     ai_provider IS NOT NULL AND ai_rights_reference IS NOT NULL AND
     ai_rights_attested_at IS NOT NULL AND ai_rights_expires_at IS NOT NULL AND
     ai_rights_revoked_at IS NULL));

-- Existing analyses remain valid and do not gain paid authorization retroactively.
ALTER TABLE marketrift.document_analyses
  ADD COLUMN requested_provider text CHECK (requested_provider IN ('test', 'openai')),
  ADD COLUMN requested_model text,
  ADD COLUMN max_output_tokens integer CHECK (max_output_tokens BETWEEN 128 AND 512),
  ADD COLUMN budget_usd numeric(8,4) CHECK (budget_usd > 0 AND budget_usd <= 0.05),
  ADD COLUMN estimated_max_cost_usd numeric(8,4),
  ADD COLUMN paid_approved_at timestamptz,
  ADD CONSTRAINT b2b_analysis_request_check CHECK (
    requested_provider IS NULL OR
    (requested_provider = 'test' AND requested_model = 'controlled-test-fixture-v1'
     AND paid_approved_at IS NULL) OR
    (requested_provider = 'openai' AND requested_model IS NOT NULL
     AND max_output_tokens IS NOT NULL AND budget_usd IS NOT NULL
     AND paid_approved_at IS NOT NULL));

COMMIT;
