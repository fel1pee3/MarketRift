import { readFileSync } from 'node:fs';
import pg from 'pg';

if (!process.env.DATABASE_ADMIN_URL) throw new Error('DATABASE_ADMIN_URL is required');
const client = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL });
await client.connect();
try {
  const current = await client.query(`SELECT confdeltype FROM pg_constraint
    WHERE conrelid='marketrift.public_page_origins'::regclass
      AND conname='public_page_origins_tenant_id_confirmed_by_fkey'`);
  if (current.rows[0]?.confdeltype === 'n') console.log('033_individual_page_origin_reviewer.sql already applied');
  else {
    await client.query(readFileSync(new URL('../db/migrations/033_individual_page_origin_reviewer.sql', import.meta.url), 'utf8'));
    console.log('Applied 033_individual_page_origin_reviewer.sql');
  }
} finally { await client.end(); }
