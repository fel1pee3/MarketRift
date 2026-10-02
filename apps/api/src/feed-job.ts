import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';

export interface SyncFeedJobV1 {
  version: 1; tenant_id: string; source_id: string; run_id: string;
  monitor_generation?: number; idempotency_key: string;
}
const ajv = new Ajv2020({ strict: false });
addFormats(ajv);
const schema = JSON.parse(readFileSync(join(__dirname, '../../../packages/contracts/sync-feed-job.v1.schema.json'), 'utf8')) as object;
const validate = ajv.compile<SyncFeedJobV1>(schema);
export function makeFeedJob(tenantId: string, sourceId: string, runId: string,
  generation?: number): SyncFeedJobV1 {
  const job: SyncFeedJobV1 = { version: 1, tenant_id: tenantId, source_id: sourceId,
    run_id: runId, idempotency_key: `feed-${runId}-v1` };
  if (generation !== undefined) job.monitor_generation = generation;
  if (!validate(job)) throw new Error(`Invalid feed job contract: ${ajv.errorsText(validate.errors)}`);
  return job;
}
