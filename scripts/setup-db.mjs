import { readFileSync } from 'node:fs';
import pg from 'pg';
const { Client, escapeLiteral } = pg;

const required = ['DATABASE_ADMIN_URL', 'RUNTIME_DB_PASSWORD', 'PROVISION_DB_PASSWORD'];
for (const name of required) if (!process.env[name]) throw new Error(`Missing ${name}`);
const client = new Client({ connectionString: process.env.DATABASE_ADMIN_URL });
await client.connect();
try {
  for (const name of ['001_initial.sql', '002_full_product.sql', '003_first_slice.sql', '004_account_security.sql', '005_review_analysis.sql', '006_github_issues.sql']) {
    const sql = readFileSync(new URL(`../db/migrations/${name}`, import.meta.url), 'utf8');
    await client.query(sql);
    console.log(`Applied ${name}`);
  }
  await client.query(`CREATE ROLE marketrift_api_login LOGIN INHERIT PASSWORD ${escapeLiteral(process.env.RUNTIME_DB_PASSWORD)}`);
  await client.query(`CREATE ROLE marketrift_auth_login LOGIN INHERIT PASSWORD ${escapeLiteral(process.env.PROVISION_DB_PASSWORD)}`);
  await client.query('GRANT marketrift_runtime TO marketrift_api_login');
  await client.query('GRANT marketrift_provisioner TO marketrift_auth_login');
  console.log('Created separate runtime and provisioning logins');
} finally { await client.end(); }
