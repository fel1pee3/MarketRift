import { readFileSync } from 'node:fs';
import pg from 'pg';

if (!process.env.DATABASE_ADMIN_URL) throw new Error('DATABASE_ADMIN_URL is required');
const client = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL });
await client.connect();
try {
  const existing = await client.query("SELECT 1 FROM information_schema.tables WHERE table_schema = 'marketrift' AND table_name = 'evidence_chunks'");
  if (existing.rowCount) console.log('013_evidence_chunks.sql already applied');
  else {
    await client.query(readFileSync(new URL('../db/migrations/013_evidence_chunks.sql', import.meta.url), 'utf8'));
    console.log('Applied 013_evidence_chunks.sql');
  }
} finally { await client.end(); }
