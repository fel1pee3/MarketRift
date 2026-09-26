import { readFileSync } from 'node:fs';
import pg from 'pg';

if (!process.env.DATABASE_ADMIN_URL) throw new Error('DATABASE_ADMIN_URL is required');
const client = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL });
await client.connect();
try {
  const existing = await client.query(`SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'marketrift' AND table_name = 'reviewable_signals'`);
  if (existing.rowCount) console.log('016_reviewable_signals.sql already applied');
  else {
    await client.query(readFileSync(new URL('../db/migrations/016_reviewable_signals.sql', import.meta.url), 'utf8'));
    console.log('Applied 016_reviewable_signals.sql');
  }
  const readPermission = await client.query(`SELECT has_table_privilege(
    'marketrift_runtime', 'marketrift.signal_alert_reads', 'DELETE') AS allowed`);
  if (!readPermission.rows[0]?.allowed) {
    await client.query('GRANT DELETE ON marketrift.signal_alert_reads TO marketrift_runtime');
    console.log('Applied alert read-state permission correction');
  }
} finally { await client.end(); }
