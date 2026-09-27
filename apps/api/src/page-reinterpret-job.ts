export const currentPageRuleVersion = 3;

export type ReinterpretWebPageJobV1 = {
  version: 1;
  tenant_id: string;
  source_id: string;
  snapshot_id: string;
  interpretation_id: string;
  rule_version: number;
  idempotency_key: string;
};

export function makePageReinterpretJob(tenantId: string, sourceId: string, snapshotId: string,
  interpretationId: string): ReinterpretWebPageJobV1 {
  return { version: 1, tenant_id: tenantId, source_id: sourceId, snapshot_id: snapshotId,
    interpretation_id: interpretationId, rule_version: currentPageRuleVersion,
    idempotency_key: `page-reinterpret-${interpretationId}-v1` };
}
