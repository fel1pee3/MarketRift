import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';

export interface IngestReviewJobV1 {
  version: 1;
  tenant_id: string;
  import_id: string;
  source_id: string;
  idempotency_key: string;
}
const ajv = new Ajv2020({ strict: false });
addFormats(ajv);
const schema = JSON.parse(readFileSync(join(__dirname, '../../../packages/contracts/ingest-review-job.v1.schema.json'), 'utf8')) as object;
const validate = ajv.compile<IngestReviewJobV1>(schema);

export function makeJob(tenantId: string, importId: string, sourceId: string): IngestReviewJobV1 {
  const job: IngestReviewJobV1 = {
    version: 1, tenant_id: tenantId, import_id: importId, source_id: sourceId,
    idempotency_key: `import-${importId}-v1`,
  };
  if (!validate(job)) throw new Error(`Invalid job contract: ${ajv.errorsText(validate.errors)}`);
  return job;
}
