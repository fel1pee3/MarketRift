import { readFileSync } from 'node:fs';
import pg from 'pg';

if (!process.env.DATABASE_ADMIN_URL) throw new Error('DATABASE_ADMIN_URL is required');
const client = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL });
await client.connect();
try {
  const privilege = await client.query(`SELECT has_column_privilege(
    'marketrift_provisioner','marketrift.sources','access_environment','SELECT') AS granted`);
  if (privilege.rows[0]?.granted) console.log('023_page_scheduler_environment_grant.sql already applied');
  else {
    await client.query(readFileSync(new URL('../db/migrations/023_page_scheduler_environment_grant.sql', import.meta.url), 'utf8'));
    console.log('Applied 023_page_scheduler_environment_grant.sql');
  }
} finally { await client.end(); }
