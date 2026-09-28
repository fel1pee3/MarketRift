import assert from 'node:assert/strict';
import test from 'node:test';
import { Db } from '../src/db';
import { B2BRightsLifecycle } from '../src/b2b-rights-lifecycle';

const tenantId = '11111111-1111-4111-8111-111111111111';
const sourceId = '22222222-2222-4222-8222-222222222222';

test('a failed purge rolls back, records a safe reason, and can be retried without duplicate counts', async () => {
  const sql: string[] = [];
  let firstAttempt = true;
  const source = { id: sourceId, tenant_id: tenantId, source_type: 'b2b_csv_review',
    access_environment: 'production', b2b_retention_policy: 'delete_on_expiry',
    b2b_deletion_status: 'not_required', b2b_deletion_reason: null,
    rights_expires_at: new Date('2020-01-01T00:00:00Z') };
  const client = { query: async (statement: string) => {
    sql.push(statement);
    if (statement.startsWith('DELETE FROM marketrift.documents')) return { rowCount: 1 };
    if (statement.startsWith('DELETE FROM marketrift.import_rows')) return { rowCount: 2 };
    return { rowCount: 0 };
  } };
  const db = {
    tenant: async (tenant: string, work: (client: typeof client) => Promise<unknown>) => {
      assert.equal(tenant, tenantId);
      if (firstAttempt) {
        firstAttempt = false;
        throw { code: '23503' };
      }
      return work(client);
    },
    rows: async (_client: unknown, statement: string) =>
      statement.includes('b2b_quality_items') ? [] : [source],
  } as unknown as Db;
  const lifecycle = new B2BRightsLifecycle(db);
  assert.deepEqual(await lifecycle.process(tenantId, sourceId), {
    status: 'failed', documents_removed: 0, import_rows_removed: 0,
    error_code: 'foreign_key_dependency',
  });
  assert(sql.some(statement => statement.includes("b2b_deletion_status='failed'")));
  assert(sql.some(statement => statement.includes("'deletion_failed'")));
  assert.deepEqual(await lifecycle.process(tenantId, sourceId), {
    status: 'completed', documents_removed: 1, import_rows_removed: 2, error_code: null,
  });
  assert(sql.some(statement => statement.includes("'deletion_completed'")));
  source.b2b_deletion_status = 'completed';
  assert.equal((await lifecycle.process(tenantId, sourceId)).status, 'not_due');
  assert.equal(sql.filter(statement => statement.startsWith('DELETE FROM marketrift.documents')).length, 1);
});
