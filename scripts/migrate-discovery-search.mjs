import { readFileSync } from 'node:fs';
import pg from 'pg';

if (!process.env.DATABASE_ADMIN_URL) throw new Error('DATABASE_ADMIN_URL is required');
const client = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL });
await client.connect();
try {
  const existing = await client.query(`SELECT 1 FROM information_schema.columns
    WHERE table_schema='marketrift' AND table_name='discovery_runs'
      AND column_name='external_search_status'`);
  if (existing.rowCount) console.log('021_discovery_search.sql already applied');
  else {
    await client.query(readFileSync(new URL('../db/migrations/021_discovery_search.sql', import.meta.url), 'utf8'));
    console.log('Applied 021_discovery_search.sql');
  }
} finally { await client.end(); }
