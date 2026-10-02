import { readFileSync } from 'node:fs';
import pg from 'pg';

if (!process.env.DATABASE_ADMIN_URL) throw new Error('DATABASE_ADMIN_URL is required');
const client = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL });
await client.connect();
try {
  const existing = await client.query(`SELECT 1 FROM pg_constraint
    WHERE conrelid='marketrift.source_runs'::regclass AND conname='source_runs_status_check'
      AND pg_get_constraintdef(oid) LIKE '%cancelled%'`);
  if (existing.rowCount) console.log('030_feed_run_cancellation.sql already applied');
  else {
    await client.query(readFileSync(new URL('../db/migrations/030_feed_run_cancellation.sql', import.meta.url), 'utf8'));
    console.log('Applied 030_feed_run_cancellation.sql');
  }
} finally { await client.end(); }
