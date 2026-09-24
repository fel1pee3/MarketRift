-- First vertical slice. Apply after 001 and 002 on a fresh database.
BEGIN;
ALTER TABLE marketrift.users ADD COLUMN password_hash text NOT NULL;
ALTER TABLE marketrift.sources DROP CONSTRAINT sources_source_type_check;
ALTER TABLE marketrift.sources ADD CONSTRAINT sources_source_type_check
  CHECK (source_type IN ('manual_review', 'reclameaqui', 'g2', 'app_store',
    'play_store', 'release_notes', 'pricing_page'));
ALTER TABLE marketrift.import_rows ADD COLUMN synthetic boolean NOT NULL DEFAULT false;
ALTER TABLE marketrift.documents ADD COLUMN synthetic boolean NOT NULL DEFAULT false;

CREATE ROLE marketrift_provisioner NOLOGIN NOSUPERUSER NOBYPASSRLS;
CREATE POLICY provision_tenants ON marketrift.tenants TO marketrift_provisioner
  USING (true) WITH CHECK (true);
CREATE POLICY provision_memberships ON marketrift.memberships TO marketrift_provisioner
  USING (true) WITH CHECK (true);
GRANT USAGE ON SCHEMA marketrift TO marketrift_provisioner;
GRANT SELECT, INSERT ON marketrift.users TO marketrift_provisioner;
GRANT SELECT, INSERT ON marketrift.tenants, marketrift.memberships TO marketrift_provisioner;
COMMIT;
