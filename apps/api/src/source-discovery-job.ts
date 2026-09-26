import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';

export interface DiscoverSourcesJobV1 {
  version: 1; tenant_id: string; product_id: string; run_id: string;
  identity_version: number; idempotency_key: string;
}
const ajv = new Ajv2020({ strict: false });
addFormats(ajv);
const schema = JSON.parse(readFileSync(join(__dirname, '../../../packages/contracts/discover-sources-job.v1.schema.json'), 'utf8')) as object;
const validate = ajv.compile<DiscoverSourcesJobV1>(schema);
export function makeDiscoveryJob(tenantId: string, productId: string, runId: string,
  identityVersion: number): DiscoverSourcesJobV1 {
  const job: DiscoverSourcesJobV1 = { version: 1, tenant_id: tenantId, product_id: productId,
    run_id: runId, identity_version: identityVersion, idempotency_key: `source-discovery-${runId}-v1` };
  if (!validate(job)) throw new Error(`Invalid discovery job: ${ajv.errorsText(validate.errors)}`);
  return job;
}
