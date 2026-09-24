import assert from 'node:assert/strict';
import test from 'node:test';
import { sign } from 'jsonwebtoken';
import { ApiController } from '../src/routes';
import { Db } from '../src/db';
import { Jobs } from '../src/queue';
import { Request } from 'express';

const secret = 'test-secret-that-is-at-least-32-characters';
process.env.JWT_SECRET = secret;
const tenantA = 'b522d3cb-556c-46f3-bca3-a4d9a3a75e69';
const tenantB = 'e8f28408-d57b-4839-989b-f519550c8e0d';
const userA = '79d47c62-9f2e-4dd6-97db-abdbbbfd7660';

function request(tenantId: string): Request {
  const jwt = sign({ tenant_id: tenantId }, secret, { subject: userA, issuer: 'marketrift-api', audience: 'marketrift-web' });
  return { headers: { authorization: `Bearer ${jwt}` } } as Request;
}

test('signed identity still needs membership in the selected tenant', async () => {
  const db = {
    tenant: async (tenantId: string, callback: (client: object) => Promise<unknown>) => callback({ tenantId }),
    rows: async (client: { tenantId: string }) => client.tenantId === tenantA ? [{ role: 'viewer' }] : [],
  } as unknown as Db;
  const controller = new ApiController(db, {} as Jobs);
  assert.deepEqual(await controller.me(request(tenantA)), { userId: userA, tenantId: tenantA, role: 'viewer' });
  await assert.rejects(controller.me(request(tenantB)), { status: 401 });
});

test('viewer cannot create a product even with valid membership', async () => {
  const db = {
    tenant: async (_tenantId: string, callback: (client: object) => Promise<unknown>) => callback({}),
    rows: async () => [{ role: 'viewer' }],
  } as unknown as Db;
  const controller = new ApiController(db, {} as Jobs);
  await assert.rejects(controller.createProduct(request(tenantA), { name: 'Forbidden', kind: 'own' }), { status: 403 });
});
