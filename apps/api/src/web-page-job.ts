import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';

export interface CheckWebPageJobV1 {
  version: 1;
  tenant_id: string;
  source_id: string;
  run_id: string;
  idempotency_key: string;
}
const ajv = new Ajv2020({ strict: false });
addFormats(ajv);
const schema = JSON.parse(readFileSync(join(__dirname, '../../../packages/contracts/check-web-page-job.v1.schema.json'), 'utf8')) as object;
const validate = ajv.compile<CheckWebPageJobV1>(schema);

export function makeWebPageJob(tenantId: string, sourceId: string, runId: string): CheckWebPageJobV1 {
  const job: CheckWebPageJobV1 = {
    version: 1, tenant_id: tenantId, source_id: sourceId, run_id: runId,
    idempotency_key: `web-page-${runId}-v1`,
  };
  if (!validate(job)) throw new Error(`Invalid web page job contract: ${ajv.errorsText(validate.errors)}`);
  return job;
}
