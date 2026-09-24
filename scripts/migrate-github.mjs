import { readFileSync } from 'node:fs';
import pg from 'pg';

if (!process.env.DATABASE_ADMIN_URL) throw new Error('DATABASE_ADMIN_URL is required');
const client = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL });
await client.connect();
try {
  const existing = await client.query("SELECT 1 FROM information_schema.columns WHERE table_schema = 'marketrift' AND table_name = 'documents' AND column_name = 'source_repository'");
  if (existing.rowCount) console.log('006_github_issues.sql already applied');
  else {
    const sql = readFileSync(new URL('../db/migrations/006_github_issues.sql', import.meta.url), 'utf8');
    await client.query(sql);
    console.log('Applied 006_github_issues.sql');
  }
} finally { await client.end(); }
