import { readFileSync } from 'node:fs';
import pg from 'pg';

if (!process.env.DATABASE_ADMIN_URL) throw new Error('DATABASE_ADMIN_URL is required');
const client = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL });
await client.connect();
try {
  const existing = await client.query(`SELECT 1 FROM information_schema.columns
    WHERE table_schema='marketrift' AND table_name='source_runs' AND column_name='capture_mode'`);
  if (existing.rowCount) console.log('034_rendered_public_page_runs.sql already applied');
  else {
    await client.query(readFileSync(new URL('../db/migrations/034_rendered_public_page_runs.sql', import.meta.url), 'utf8'));
    console.log('Applied 034_rendered_public_page_runs.sql');
  }
} finally { await client.end(); }
