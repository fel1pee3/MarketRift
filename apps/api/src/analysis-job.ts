import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';

export interface AnalyzeDocumentJobV1 {
  version: 1;
  tenant_id: string;
  document_id: string;
  extractor_version: string;
  idempotency_key: string;
}

export const activeExtractorVersion = process.env.EXTRACTOR_VERSION ?? 'review-issues-v1';
const ajv = new Ajv2020({ strict: false });
addFormats(ajv);
const schema = JSON.parse(readFileSync(join(__dirname, '../../../packages/contracts/analyze-document-job.v1.schema.json'), 'utf8')) as object;
const validate = ajv.compile<AnalyzeDocumentJobV1>(schema);

export function makeAnalysisJob(tenantId: string, documentId: string): AnalyzeDocumentJobV1 {
  const job: AnalyzeDocumentJobV1 = {
    version: 1, tenant_id: tenantId, document_id: documentId,
    extractor_version: activeExtractorVersion,
    idempotency_key: `analysis-${documentId}-${activeExtractorVersion}`,
  };
  if (!validate(job)) throw new Error(`Invalid analysis job contract: ${ajv.errorsText(validate.errors)}`);
  return job;
}
