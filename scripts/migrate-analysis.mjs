import { readFileSync } from 'node:fs';
import pg from 'pg';

if (!process.env.DATABASE_ADMIN_URL) throw new Error('DATABASE_ADMIN_URL is required');
const client = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL });
await client.connect();
try {
  const existing = await client.query("SELECT to_regclass('marketrift.document_analyses') AS analyses");
  if (existing.rows[0].analyses) {
    console.log('005_review_analysis.sql already applied');
  } else {
    const sql = readFileSync(new URL('../db/migrations/005_review_analysis.sql', import.meta.url), 'utf8');
    await client.query(sql);
    console.log('Applied 005_review_analysis.sql');
  }
} finally { await client.end(); }
