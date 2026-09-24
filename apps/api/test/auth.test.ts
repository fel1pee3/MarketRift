import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import type { Request } from 'express';
import { Accounts, browserCookiePolicy } from '../src/accounts';
import { ApiController } from '../src/routes';
import { Db } from '../src/db';
import { Jobs } from '../src/queue';

const secret = 'test-secret-that-is-at-least-32-characters';
process.env.JWT_SECRET = secret;
const raw = 'a'.repeat(64);
const csrf = createHmac('sha256', secret).update('marketrift-csrf-v1:').update(raw).digest('hex');
const tenantA = 'b522d3cb-556c-46f3-bca3-a4d9a3a75e69';
const tenantB = 'e8f28408-d57b-4839-989b-f519550c8e0d';
const userA = '79d47c62-9f2e-4dd6-97db-abdbbbfd7660';

function request(method = 'GET', csrfToken = csrf): Request {
  return {
    method, headers: { cookie: `marketrift_session=${raw}` },
    header: (name: string) => name.toLowerCase() === 'x-csrf-token' ? csrfToken : undefined,
  } as unknown as Request;
}
function accounts(selectedTenant: string): Accounts {
  const db = {
    provisioning: { query: async () => ({ rows: [{ id: 'session-id', user_id: userA, tenant_id: selectedTenant, email: 'user@example.com' }] }) },
    tenant: async (tenantId: string, callback: (client: object) => Promise<unknown>) => callback({ tenantId }),
    rows: async (client: { tenantId: string }) => client.tenantId === tenantA ? [{ role: 'viewer' }] : [],
  } as unknown as Db;
  return new Accounts(db);
}

test('session identity still needs active membership in selected tenant', async () => {
  const valid = await accounts(tenantA).principal(request());
  assert.equal(valid.tenantId, tenantA);
  assert.equal(valid.role, 'viewer');
  await assert.rejects(accounts(tenantB).principal(request()), { status: 401 });
});

test('viewer cannot write and mutations require the CSRF header', async () => {
  const auth = accounts(tenantA);
  const controller = new ApiController({} as Db, {} as Jobs, auth);
  await assert.rejects(controller.createProduct(request('POST'), { name: 'Forbidden', kind: 'own' }), { status: 403 });
  await assert.rejects(auth.principal(request('POST', '')), { status: 403, message: 'Invalid CSRF token' });
});

test('production cookie is host-bound, Secure and invisible to browser JavaScript', () => {
  const production = browserCookiePolicy('production');
  assert.equal(production.name, '__Host-marketrift_session');
  assert.deepEqual(production.options, { httpOnly: true, secure: true, sameSite: 'lax', path: '/' });
  assert.equal(browserCookiePolicy('development').options.secure, false);
});
