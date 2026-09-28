import { readFileSync } from 'node:fs';
import pg from 'pg';

if (!process.env.DATABASE_ADMIN_URL) throw new Error('DATABASE_ADMIN_URL is required');
const client = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL });
await client.connect();
try {
  const existing = await client.query(`SELECT 1 FROM information_schema.columns
    WHERE table_schema='marketrift' AND table_name='sources' AND column_name='b2b_retention_policy'`);
  if (existing.rowCount) console.log('026_b2b_rights_lifecycle.sql already applied');
  else {
    await client.query(readFileSync(new URL('../db/migrations/026_b2b_rights_lifecycle.sql', import.meta.url), 'utf8'));
    console.log('Applied 026_b2b_rights_lifecycle.sql');
  }
} finally { await client.end(); }
