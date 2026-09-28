import { readFileSync } from 'node:fs';
import pg from 'pg';
const { Client, escapeLiteral } = pg;

const required = ['DATABASE_ADMIN_URL', 'RUNTIME_DB_PASSWORD', 'PROVISION_DB_PASSWORD'];
for (const name of required) if (!process.env[name]) throw new Error(`Missing ${name}`);
const client = new Client({ connectionString: process.env.DATABASE_ADMIN_URL });
await client.connect();
try {
  for (const name of ['001_initial.sql', '002_full_product.sql', '003_first_slice.sql', '004_account_security.sql', '005_review_analysis.sql', '006_github_issues.sql', '007_steam_reviews.sql', '008_web_pages.sql', '009_page_monitoring.sql', '010_github_discussions.sql', '011_b2b_review_rights.sql', '012_b2b_analysis_rights.sql', '013_evidence_chunks.sql', '014_retrieval_review.sql', '015_retrieval_origin.sql', '016_reviewable_signals.sql', '017_signal_reconciliation.sql', '018_source_discovery.sql', '019_discovery_resource_failures.sql', '020_page_reinterpretation.sql', '021_discovery_search.sql', '022_discovery_classification.sql', '023_page_scheduler_environment_grant.sql', '024_action_hypotheses.sql', '025_b2b_quality_workspace.sql', '026_b2b_rights_lifecycle.sql', '027_b2b_rights_scheduler_grant.sql', '028_github_monitoring.sql']) {
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
