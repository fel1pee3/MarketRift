-- Additive migration for revocable browser sessions and tenant invitations.
BEGIN;

CREATE TABLE marketrift.browser_sessions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    token_hash char(64) NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (tenant_id, user_id)
        REFERENCES marketrift.memberships (tenant_id, user_id) ON DELETE CASCADE
);
CREATE INDEX browser_sessions_user_active
    ON marketrift.browser_sessions (user_id, expires_at) WHERE revoked_at IS NULL;

CREATE TABLE marketrift.member_invitations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES marketrift.tenants(id),
    email text NOT NULL CHECK (email = lower(btrim(email))),
    role text NOT NULL CHECK (role IN ('admin', 'analyst', 'viewer')),
    token_hash char(64) NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    invited_by uuid NOT NULL REFERENCES marketrift.users(id),
    expires_at timestamptz NOT NULL,
    accepted_at timestamptz,
    accepted_by uuid REFERENCES marketrift.users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, id)
);
CREATE INDEX member_invitations_tenant_created
    ON marketrift.member_invitations (tenant_id, created_at DESC);

ALTER TABLE marketrift.member_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketrift.member_invitations FORCE ROW LEVEL SECURITY;
CREATE POLICY provision_invitations ON marketrift.member_invitations
    TO marketrift_provisioner USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON marketrift.browser_sessions,
    marketrift.member_invitations TO marketrift_provisioner;
GRANT UPDATE, DELETE ON marketrift.memberships TO marketrift_provisioner;

COMMIT;
