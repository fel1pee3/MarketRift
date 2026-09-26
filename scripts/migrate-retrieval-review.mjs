import { readFileSync } from 'node:fs';
import pg from 'pg';

if (!process.env.DATABASE_ADMIN_URL) throw new Error('DATABASE_ADMIN_URL is required');
const client = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL });
await client.connect();
try {
  const existing = await client.query(`SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'marketrift' AND table_name = 'retrieval_sets'`);
  if (existing.rowCount) console.log('014_retrieval_review.sql already applied');
  else {
    await client.query(readFileSync(new URL('../db/migrations/014_retrieval_review.sql', import.meta.url), 'utf8'));
    console.log('Applied 014_retrieval_review.sql');
  }
  const origin = await client.query(`SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'marketrift' AND table_name = 'retrieval_sets' AND column_name = 'origin'`);
  if (origin.rowCount) console.log('015_retrieval_origin.sql already applied');
  else {
    await client.query(readFileSync(new URL('../db/migrations/015_retrieval_origin.sql', import.meta.url), 'utf8'));
    console.log('Applied 015_retrieval_origin.sql');
  }
} finally { await client.end(); }
