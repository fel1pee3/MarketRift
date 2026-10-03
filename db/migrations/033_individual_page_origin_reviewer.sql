-- Retain reviewed page provenance when a team member is removed.
BEGIN;
ALTER TABLE marketrift.public_page_origins DROP CONSTRAINT public_page_origins_tenant_id_confirmed_by_fkey;
ALTER TABLE marketrift.public_page_origins ALTER COLUMN confirmed_by DROP NOT NULL;
ALTER TABLE marketrift.public_page_origins ADD CONSTRAINT public_page_origins_tenant_id_confirmed_by_fkey
  FOREIGN KEY (tenant_id,confirmed_by) REFERENCES marketrift.memberships(tenant_id,user_id)
  ON DELETE SET NULL (confirmed_by);
COMMIT;
