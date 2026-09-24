-- Expansao de dominio do MarketRift. Aplicar depois de 001_initial.sql.
-- Requer execucao pelo papel de migracao, distinto do runtime.
BEGIN;

ALTER TABLE marketrift.price_observations
    ADD CONSTRAINT prices_tenant_id_id_unique UNIQUE (tenant_id, id);

CREATE TABLE marketrift.watch_topics (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES marketrift.tenants(id),
    name text NOT NULL CHECK (length(btrim(name)) > 0),
    enabled boolean NOT NULL DEFAULT true,
    UNIQUE (tenant_id, id),
    UNIQUE (tenant_id, name)
);

CREATE TABLE marketrift.product_capabilities (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    product_id uuid NOT NULL,
    topic_id uuid NOT NULL,
    claim text NOT NULL CHECK (length(btrim(claim)) > 0),
    evidence_url text,
    verification_status text NOT NULL DEFAULT 'unverified'
        CHECK (verification_status IN ('unverified', 'verified', 'rejected')),
    verified_at timestamptz,
    UNIQUE (tenant_id, id),
    FOREIGN KEY (tenant_id, product_id) REFERENCES marketrift.products (tenant_id, id),
    FOREIGN KEY (tenant_id, topic_id) REFERENCES marketrift.watch_topics (tenant_id, id)
);

CREATE TABLE marketrift.source_runs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    source_id uuid NOT NULL,
    status text NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'failed')),
    cursor_before text,
    cursor_after text,
    documents_seen integer NOT NULL DEFAULT 0 CHECK (documents_seen >= 0),
    documents_new integer NOT NULL DEFAULT 0 CHECK (documents_new >= 0),
    error_code text,
    started_at timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz,
    UNIQUE (tenant_id, id),
    FOREIGN KEY (tenant_id, source_id) REFERENCES marketrift.sources (tenant_id, id)
);

CREATE TABLE marketrift.source_snapshots (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    run_id uuid NOT NULL,
    source_url text NOT NULL,
    storage_key text NOT NULL,
    content_sha256 char(64) NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
    fetched_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, id),
    UNIQUE (tenant_id, run_id, content_sha256),
    FOREIGN KEY (tenant_id, run_id) REFERENCES marketrift.source_runs (tenant_id, id)
);

CREATE TABLE marketrift.release_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    source_id uuid NOT NULL,
    document_id uuid,
    external_key text NOT NULL,
    title text NOT NULL,
    version_label text,
    summary text,
    released_at timestamptz,
    source_url text NOT NULL,
    UNIQUE (tenant_id, id),
    UNIQUE (tenant_id, source_id, external_key),
    FOREIGN KEY (tenant_id, source_id) REFERENCES marketrift.sources (tenant_id, id),
    FOREIGN KEY (tenant_id, document_id) REFERENCES marketrift.documents (tenant_id, id)
);

CREATE TABLE marketrift.market_signals (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    competitor_product_id uuid NOT NULL,
    signal_type text NOT NULL CHECK (signal_type IN
        ('complaint_spike', 'price_change', 'release_impact', 'feature_gap')),
    topic text NOT NULL,
    window_start timestamptz NOT NULL,
    window_end timestamptz NOT NULL CHECK (window_end > window_start),
    baseline_numerator integer CHECK (baseline_numerator >= 0),
    baseline_denominator integer CHECK (baseline_denominator > 0),
    current_numerator integer CHECK (current_numerator >= 0),
    current_denominator integer CHECK (current_denominator > 0),
    score numeric(5,2) CHECK (score BETWEEN 0 AND 100),
    confidence text NOT NULL CHECK (confidence IN ('low', 'medium', 'high')),
    summary text NOT NULL,
    detector_version text NOT NULL,
    detected_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, id),
    UNIQUE (tenant_id, competitor_product_id, signal_type, topic,
            window_start, window_end, detector_version),
    FOREIGN KEY (tenant_id, competitor_product_id)
        REFERENCES marketrift.products (tenant_id, id)
);

-- Uma evidencia aponta para exatamente um tipo de origem, sempre do mesmo tenant.
CREATE TABLE marketrift.signal_evidence (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    signal_id uuid NOT NULL,
    document_id uuid,
    price_observation_id uuid,
    release_event_id uuid,
    evidence_note text,
    CHECK (num_nonnulls(document_id, price_observation_id, release_event_id) = 1),
    FOREIGN KEY (tenant_id, signal_id) REFERENCES marketrift.market_signals (tenant_id, id),
    FOREIGN KEY (tenant_id, document_id) REFERENCES marketrift.documents (tenant_id, id),
    FOREIGN KEY (tenant_id, price_observation_id)
        REFERENCES marketrift.price_observations (tenant_id, id),
    FOREIGN KEY (tenant_id, release_event_id) REFERENCES marketrift.release_events (tenant_id, id)
);

CREATE TABLE marketrift.recommendations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    signal_id uuid NOT NULL,
    proposed_action text NOT NULL,
    rationale text NOT NULL,
    claims_to_verify text,
    review_status text NOT NULL DEFAULT 'draft'
        CHECK (review_status IN ('draft', 'approved', 'rejected')),
    reviewed_by uuid,
    reviewed_at timestamptz,
    generator_version text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, id),
    FOREIGN KEY (tenant_id, signal_id) REFERENCES marketrift.market_signals (tenant_id, id),
    FOREIGN KEY (tenant_id, reviewed_by) REFERENCES marketrift.memberships (tenant_id, user_id)
);

CREATE TABLE marketrift.alerts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    signal_id uuid NOT NULL,
    severity text NOT NULL CHECK (severity IN ('low', 'medium', 'high')),
    status text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'seen', 'dismissed')),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, id),
    UNIQUE (tenant_id, signal_id),
    FOREIGN KEY (tenant_id, signal_id) REFERENCES marketrift.market_signals (tenant_id, id)
);

CREATE TABLE marketrift.alert_deliveries (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    alert_id uuid NOT NULL,
    recipient_user_id uuid NOT NULL,
    channel text NOT NULL CHECK (channel IN ('in_app', 'email')),
    status text NOT NULL CHECK (status IN ('pending', 'sent', 'failed')),
    attempted_at timestamptz,
    UNIQUE (tenant_id, alert_id, recipient_user_id, channel),
    FOREIGN KEY (tenant_id, alert_id) REFERENCES marketrift.alerts (tenant_id, id),
    FOREIGN KEY (tenant_id, recipient_user_id)
        REFERENCES marketrift.memberships (tenant_id, user_id)
);

CREATE TABLE marketrift.chat_threads (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES marketrift.tenants(id),
    created_by uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, id),
    FOREIGN KEY (tenant_id, created_by) REFERENCES marketrift.memberships (tenant_id, user_id)
);

CREATE TABLE marketrift.chat_messages (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    thread_id uuid NOT NULL,
    role text NOT NULL CHECK (role IN ('user', 'assistant')),
    content text NOT NULL,
    insufficient_evidence boolean NOT NULL DEFAULT false,
    model_id text,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, id),
    FOREIGN KEY (tenant_id, thread_id) REFERENCES marketrift.chat_threads (tenant_id, id)
);

CREATE TABLE marketrift.chat_citations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    message_id uuid NOT NULL,
    document_id uuid,
    price_observation_id uuid,
    release_event_id uuid,
    CHECK (num_nonnulls(document_id, price_observation_id, release_event_id) = 1),
    FOREIGN KEY (tenant_id, message_id) REFERENCES marketrift.chat_messages (tenant_id, id),
    FOREIGN KEY (tenant_id, document_id) REFERENCES marketrift.documents (tenant_id, id),
    FOREIGN KEY (tenant_id, price_observation_id)
        REFERENCES marketrift.price_observations (tenant_id, id),
    FOREIGN KEY (tenant_id, release_event_id) REFERENCES marketrift.release_events (tenant_id, id)
);

CREATE TABLE marketrift.usage_daily (
    tenant_id uuid NOT NULL REFERENCES marketrift.tenants(id),
    usage_day date NOT NULL,
    metric text NOT NULL CHECK (metric IN ('documents', 'llm_tokens', 'embeddings', 'questions')),
    quantity numeric(16,4) NOT NULL DEFAULT 0 CHECK (quantity >= 0),
    PRIMARY KEY (tenant_id, usage_day, metric)
);

CREATE TABLE marketrift.audit_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES marketrift.tenants(id),
    actor_user_id uuid,
    action text NOT NULL,
    entity_type text NOT NULL,
    entity_id uuid,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX source_runs_by_source ON marketrift.source_runs
    (tenant_id, source_id, started_at DESC);
CREATE INDEX signals_by_product ON marketrift.market_signals
    (tenant_id, competitor_product_id, detected_at DESC);
CREATE INDEX recommendations_by_status ON marketrift.recommendations
    (tenant_id, review_status, created_at DESC);
CREATE INDEX alerts_by_status ON marketrift.alerts (tenant_id, status, created_at DESC);
CREATE INDEX messages_by_thread ON marketrift.chat_messages
    (tenant_id, thread_id, created_at);
CREATE INDEX audit_by_tenant_time ON marketrift.audit_events
    (tenant_id, occurred_at DESC);

DO $rls$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'watch_topics', 'product_capabilities', 'source_runs', 'source_snapshots',
    'release_events', 'market_signals', 'signal_evidence', 'recommendations',
    'alerts', 'alert_deliveries', 'chat_threads', 'chat_messages',
    'chat_citations', 'usage_daily', 'audit_events'
  ] LOOP
    EXECUTE format('ALTER TABLE marketrift.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE marketrift.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_scope ON marketrift.%I TO marketrift_runtime '
      || 'USING (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid) '
      || 'WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)',
      table_name
    );
  END LOOP;
END
$rls$;

GRANT SELECT, INSERT, UPDATE, DELETE ON marketrift.watch_topics,
    marketrift.product_capabilities, marketrift.source_runs,
    marketrift.source_snapshots, marketrift.release_events,
    marketrift.market_signals, marketrift.signal_evidence,
    marketrift.recommendations, marketrift.alerts,
    marketrift.alert_deliveries, marketrift.chat_threads,
    marketrift.chat_messages, marketrift.chat_citations,
    marketrift.usage_daily, marketrift.audit_events TO marketrift_runtime;

COMMIT;
