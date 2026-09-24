import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';

export interface SyncGitHubIssuesJobV1 {
  version: 1;
  tenant_id: string;
  source_id: string;
  run_id: string;
  idempotency_key: string;
}
const ajv = new Ajv2020({ strict: false });
addFormats(ajv);
const schema = JSON.parse(readFileSync(join(__dirname, '../../../packages/contracts/sync-github-issues-job.v1.schema.json'), 'utf8')) as object;
const validate = ajv.compile<SyncGitHubIssuesJobV1>(schema);

export function makeGitHubJob(tenantId: string, sourceId: string, runId: string): SyncGitHubIssuesJobV1 {
  const job: SyncGitHubIssuesJobV1 = {
    version: 1, tenant_id: tenantId, source_id: sourceId, run_id: runId,
    idempotency_key: `github-issues-${runId}-v1`,
  };
  if (!validate(job)) throw new Error(`Invalid GitHub job contract: ${ajv.errorsText(validate.errors)}`);
  return job;
}
