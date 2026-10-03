import { readFileSync } from 'node:fs';
import pg from 'pg';

if (!process.env.DATABASE_ADMIN_URL) throw new Error('DATABASE_ADMIN_URL is required');
const client = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL });
await client.connect();
try {
  const existing = await client.query(`SELECT 1 FROM information_schema.tables
    WHERE table_schema='marketrift' AND table_name='public_page_origins'`);
  if (existing.rowCount) console.log('032_individual_public_pages.sql already applied');
  else {
    await client.query(readFileSync(new URL('../db/migrations/032_individual_public_pages.sql', import.meta.url), 'utf8'));
    console.log('Applied 032_individual_public_pages.sql');
  }
} finally { await client.end(); }
