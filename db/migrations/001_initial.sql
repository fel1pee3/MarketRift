-- MarketRift: proposta de migracao inicial (PostgreSQL 16+ e pgvector).
-- Executar em banco dedicado com papel de migracao distinto do papel da API.
-- Ajustar a dimensao 1536 e o nome do modelo antes de usar outro embedding.

BEGIN;

CREATE EXTENSION IF NOT EXISTS vector;
CREATE SCHEMA marketrift;
CREATE ROLE marketrift_runtime NOLOGIN NOSUPERUSER NOBYPASSRLS;

CREATE TABLE marketrift.tenants (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL CHECK (length(btrim(name)) > 0),
    created_at timestamptz NOT NULL DEFAULT now()
);

-- Identidade global. Provisionamento/autenticacao ficam fora do papel runtime.
CREATE TABLE marketrift.users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email text NOT NULL UNIQUE CHECK (email = lower(btrim(email)) AND length(email) > 3),
    display_name text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE marketrift.memberships (
    tenant_id uuid NOT NULL REFERENCES marketrift.tenants(id),
    user_id uuid NOT NULL REFERENCES marketrift.users(id),
    role text NOT NULL CHECK (role IN ('owner', 'admin', 'analyst', 'viewer')),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, user_id)
);

-- Uma assinatura ativa/atual por tenant; historico de cobranca pertence ao provedor.
CREATE TABLE marketrift.subscriptions (
    tenant_id uuid PRIMARY KEY REFERENCES marketrift.tenants(id),
    provider_customer_id text UNIQUE,
    provider_subscription_id text UNIQUE,
    plan_code text NOT NULL,
    status text NOT NULL CHECK (status IN ('trialing', 'active', 'past_due', 'canceled')),
    current_period_end timestamptz,
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE marketrift.products (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES marketrift.tenants(id),
    name text NOT NULL CHECK (length(btrim(name)) > 0),
    kind text NOT NULL CHECK (kind IN ('own', 'competitor')),
    website_url text,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, id),
    UNIQUE (tenant_id, name)
);
CREATE UNIQUE INDEX products_one_own_per_tenant
    ON marketrift.products (tenant_id) WHERE kind = 'own';

CREATE TABLE marketrift.sources (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    product_id uuid NOT NULL,
    source_type text NOT NULL CHECK (source_type IN
        ('reclameaqui', 'g2', 'app_store', 'play_store', 'release_notes', 'pricing_page')),
    url text NOT NULL,
    enabled boolean NOT NULL DEFAULT true,
    last_checked_at timestamptz,
    UNIQUE (tenant_id, id),
    UNIQUE (tenant_id, product_id, source_type, url),
    FOREIGN KEY (tenant_id, product_id)
        REFERENCES marketrift.products (tenant_id, id)
);

-- Lote e linhas de importacao permitem retry sem colocar CSV inteiro no Redis.
CREATE TABLE marketrift.imports (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    source_id uuid NOT NULL,
    idempotency_key text NOT NULL,
    status text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'queued', 'processing', 'completed', 'failed')),
    total_rows integer NOT NULL DEFAULT 0 CHECK (total_rows >= 0),
    processed_rows integer NOT NULL DEFAULT 0 CHECK (processed_rows >= 0),
    last_error text,
    created_at timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz,
    UNIQUE (tenant_id, id),
    UNIQUE (tenant_id, idempotency_key),
    FOREIGN KEY (tenant_id, source_id)
        REFERENCES marketrift.sources (tenant_id, id)
);

CREATE TABLE marketrift.import_rows (
    tenant_id uuid NOT NULL,
    import_id uuid NOT NULL,
    external_key text NOT NULL,
    source_url text NOT NULL,
    published_at timestamptz,
    body text NOT NULL CHECK (length(btrim(body)) > 0),
    PRIMARY KEY (tenant_id, import_id, external_key),
    FOREIGN KEY (tenant_id, import_id)
        REFERENCES marketrift.imports (tenant_id, id) ON DELETE CASCADE
);

-- O texto e a proveniencia sustentam revisao humana e citacoes no RAG.
CREATE TABLE marketrift.documents (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    source_id uuid NOT NULL,
    document_type text NOT NULL CHECK (document_type IN ('review', 'release_note')),
    external_key text NOT NULL,
    source_url text NOT NULL,
    body text NOT NULL CHECK (length(btrim(body)) > 0),
    published_at timestamptz,
    collected_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, id),
    UNIQUE (tenant_id, source_id, external_key),
    FOREIGN KEY (tenant_id, source_id)
        REFERENCES marketrift.sources (tenant_id, id)
);

CREATE TABLE marketrift.insights (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    document_id uuid NOT NULL,
    sentiment text NOT NULL CHECK (sentiment IN ('positive', 'negative', 'neutral')),
    category text NOT NULL,
    pain_point text,
    severity text CHECK (severity IN ('low', 'medium', 'high')),
    evidence_quote text,
    extractor_version text NOT NULL,
    extracted_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, id),
    UNIQUE (tenant_id, document_id, extractor_version),
    FOREIGN KEY (tenant_id, document_id)
        REFERENCES marketrift.documents (tenant_id, id)
);

-- Um vetor por documento e modelo. Vetores de modelos diferentes nao devem
-- ser misturados na mesma busca; migracao de dimensao exige nova estrutura.
CREATE TABLE marketrift.document_embeddings (
    tenant_id uuid NOT NULL,
    document_id uuid NOT NULL,
    model_id text NOT NULL,
    embedding vector(1536) NOT NULL,
    embedded_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, document_id, model_id),
    FOREIGN KEY (tenant_id, document_id)
        REFERENCES marketrift.documents (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE marketrift.price_observations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    source_id uuid NOT NULL,
    plan_name text NOT NULL,
    amount numeric(12,2) NOT NULL CHECK (amount >= 0),
    currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
    billing_period text NOT NULL CHECK (billing_period IN ('month', 'year', 'one_time')),
    observed_at timestamptz NOT NULL DEFAULT now(),
    evidence_url text NOT NULL,
    FOREIGN KEY (tenant_id, source_id)
        REFERENCES marketrift.sources (tenant_id, id)
);

CREATE INDEX documents_tenant_source_date
    ON marketrift.documents (tenant_id, source_id, published_at DESC);
CREATE INDEX imports_tenant_status
    ON marketrift.imports (tenant_id, status, created_at DESC);
CREATE INDEX insights_tenant_category_date
    ON marketrift.insights (tenant_id, category, extracted_at DESC);
CREATE INDEX embeddings_tenant_model
    ON marketrift.document_embeddings (tenant_id, model_id);
CREATE INDEX prices_tenant_source_date
    ON marketrift.price_observations (tenant_id, source_id, observed_at DESC);

-- Todas as tabelas com dados de tenant usam politica fechada por padrao.
-- O contexto deve vir de JWT validado + membership checada pela API.
DO $rls$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'tenants', 'memberships', 'subscriptions', 'products', 'sources',
    'imports', 'import_rows',
    'documents', 'insights', 'document_embeddings', 'price_observations'
  ] LOOP
    EXECUTE format('ALTER TABLE marketrift.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE marketrift.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_scope ON marketrift.%I TO marketrift_runtime '
      || 'USING (%I = nullif(current_setting(''app.tenant_id'', true), '''')::uuid) '
      || 'WITH CHECK (%I = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)',
      table_name,
      CASE WHEN table_name = 'tenants' THEN 'id' ELSE 'tenant_id' END,
      CASE WHEN table_name = 'tenants' THEN 'id' ELSE 'tenant_id' END
    );
  END LOOP;
END
$rls$;

GRANT USAGE ON SCHEMA marketrift TO marketrift_runtime;
GRANT SELECT ON marketrift.tenants, marketrift.memberships,
    marketrift.subscriptions TO marketrift_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON marketrift.products,
    marketrift.sources, marketrift.imports, marketrift.import_rows,
    marketrift.documents, marketrift.insights,
    marketrift.document_embeddings, marketrift.price_observations
    TO marketrift_runtime;
-- Nenhuma permissao de runtime sobre users ou de escrita em memberships/
-- subscriptions. Provisionamento e cobranca usam fluxo privilegiado separado.

COMMIT;

-- Exemplo de contexto por requisicao/job, sempre em uma unica transacao:
-- BEGIN;
-- SELECT set_config('app.tenant_id', :validated_tenant_uuid, true);
-- SELECT d.id, d.source_url, d.body, e.embedding <=> :question_vector::vector AS distance
-- FROM marketrift.document_embeddings e
-- JOIN marketrift.documents d
--   ON (d.tenant_id, d.id) = (e.tenant_id, e.document_id)
-- WHERE e.tenant_id = :validated_tenant_uuid AND e.model_id = :model_id
-- ORDER BY e.embedding <=> :question_vector::vector LIMIT 10;
-- COMMIT;
