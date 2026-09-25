import { readFileSync } from 'node:fs';
import pg from 'pg';

if (!process.env.DATABASE_ADMIN_URL) throw new Error('DATABASE_ADMIN_URL is required');
const client = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL });
await client.connect();
try {
  const existing = await client.query("SELECT 1 FROM information_schema.columns WHERE table_schema = 'marketrift' AND table_name = 'documents' AND column_name = 'review_data_status'");
  if (existing.rowCount) console.log('011_b2b_review_rights.sql already applied');
  else {
    await client.query(readFileSync(new URL('../db/migrations/011_b2b_review_rights.sql', import.meta.url), 'utf8'));
    console.log('Applied 011_b2b_review_rights.sql');
  }
} finally { await client.end(); }
