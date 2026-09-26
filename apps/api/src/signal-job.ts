import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';

export interface ReconcileSignalsJobV1 {
  version: 1;
  tenant_id: string;
  source_id: string;
  revision: string;
  idempotency_key: string;
}
const ajv = new Ajv2020({ strict: false });
addFormats(ajv);
const schema = JSON.parse(readFileSync(join(__dirname, '../../../packages/contracts/reconcile-signals-job.v1.schema.json'), 'utf8')) as object;
const validate = ajv.compile<ReconcileSignalsJobV1>(schema);

export function parseSignalJob(value: unknown): ReconcileSignalsJobV1 {
  if (!validate(value)) throw new Error('invalid_signal_job_contract');
  const job = value as ReconcileSignalsJobV1;
  if (job.idempotency_key !== `signal-reconcile-${job.source_id}-${job.revision}-v1`) {
    throw new Error('invalid_signal_job_key');
  }
  return job;
}

export function makeSignalJob(tenantId: string, sourceId: string, revision: string): ReconcileSignalsJobV1 {
  return parseSignalJob({ version: 1, tenant_id: tenantId, source_id: sourceId,
    revision, idempotency_key: `signal-reconcile-${sourceId}-${revision}-v1` });
}
