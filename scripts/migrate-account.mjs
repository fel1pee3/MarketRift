import { readFileSync } from 'node:fs';
import pg from 'pg';

if (!process.env.DATABASE_ADMIN_URL) throw new Error('DATABASE_ADMIN_URL is required');
const client = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL });
await client.connect();
try {
  const existing = await client.query("SELECT to_regclass('marketrift.browser_sessions') AS sessions, to_regclass('marketrift.member_invitations') AS invitations");
  if (existing.rows[0].sessions && existing.rows[0].invitations) {
    console.log('004_account_security.sql already applied');
  } else {
    if (existing.rows[0].sessions || existing.rows[0].invitations) throw new Error('Partial account migration detected');
    const sql = readFileSync(new URL('../db/migrations/004_account_security.sql', import.meta.url), 'utf8');
    await client.query(sql);
    console.log('Applied 004_account_security.sql');
  }
} finally { await client.end(); }
