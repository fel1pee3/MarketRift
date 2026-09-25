import { readFileSync } from 'node:fs';
import pg from 'pg';

if (!process.env.DATABASE_ADMIN_URL) throw new Error('DATABASE_ADMIN_URL is required');
const client = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL });
await client.connect();
try {
  const existing = await client.query("SELECT 1 FROM information_schema.columns WHERE table_schema = 'marketrift' AND table_name = 'documents' AND column_name = 'discussion_category'");
  if (existing.rowCount) console.log('010_github_discussions.sql already applied');
  else {
    const sql = readFileSync(new URL('../db/migrations/010_github_discussions.sql', import.meta.url), 'utf8');
    await client.query(sql);
    console.log('Applied 010_github_discussions.sql');
  }
} finally { await client.end(); }
