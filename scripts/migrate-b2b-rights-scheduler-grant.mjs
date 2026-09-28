import { readFileSync } from 'node:fs';
import pg from 'pg';

if (!process.env.DATABASE_ADMIN_URL) throw new Error('DATABASE_ADMIN_URL is required');
const client = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL });
await client.connect();
try {
  const existing = await client.query(`SELECT 1 FROM pg_policies
    WHERE schemaname='marketrift' AND tablename='sources'
    AND policyname='scheduler_b2b_rights_sources'`);
  if (existing.rowCount) console.log('027_b2b_rights_scheduler_grant.sql already applied');
  else {
    await client.query(readFileSync(new URL('../db/migrations/027_b2b_rights_scheduler_grant.sql', import.meta.url), 'utf8'));
    console.log('Applied 027_b2b_rights_scheduler_grant.sql');
  }
} finally { await client.end(); }
