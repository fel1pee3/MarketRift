import { readFileSync } from 'node:fs';
import pg from 'pg';

if (!process.env.DATABASE_ADMIN_URL) throw new Error('DATABASE_ADMIN_URL is required');
const client = new pg.Client({ connectionString:process.env.DATABASE_ADMIN_URL });
await client.connect();
try {
  const granted = await client.query(`SELECT has_column_privilege('marketrift_provisioner',
    'marketrift.source_runs','error_code','SELECT') AS granted`);
  if (granted.rows[0]?.granted) console.log('031_feed_scheduler_error_grant.sql already applied');
  else {
    await client.query(readFileSync(new URL('../db/migrations/031_feed_scheduler_error_grant.sql',
      import.meta.url), 'utf8'));
    console.log('Applied 031_feed_scheduler_error_grant.sql');
  }
} finally { await client.end(); }
