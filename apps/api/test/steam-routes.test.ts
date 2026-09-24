import assert from 'node:assert/strict';
import test from 'node:test';
import type { Request } from 'express';
import { ApiController } from '../src/routes';
import { Accounts, Role } from '../src/accounts';
import { Db } from '../src/db';
import { Jobs } from '../src/queue';

const tenant = 'b522d3cb-556c-46f3-bca3-a4d9a3a75e69';
const product = 'e8f28408-d57b-4839-989b-f519550c8e0d';
const source = '79d47c62-9f2e-4dd6-97db-abdbbbfd7660';

test('Steam source creation checks role and product inside selected tenant', async () => {
  for (const role of ['owner', 'admin', 'analyst', 'viewer'] as Role[]) {
    const seen: string[] = [];
    const accounts = { principal: async (_request: Request, allowed: Role[]) => {
      if (!allowed.includes(role)) throw Object.assign(new Error('Forbidden'), { status: 403 });
      return { tenantId: tenant, role };
    } } as unknown as Accounts;
    const db = { tenant: async (tenantId: string, callback: (client: object) => Promise<unknown>) => {
      seen.push(tenantId); return callback({});
    }, rows: async (_client: object, sql: string, args: unknown[]) => {
      seen.push(sql); assert.equal(args[0], tenant);
      return [{ id: source, product_id: product, source_type: 'steam_reviews', url: args[2] }];
    } } as unknown as Db;
    const controller = new ApiController(db, {} as Jobs, accounts);
    if (role === 'owner' || role === 'admin') {
      const created = await controller.createSteamSource({} as Request, { product_id: product, app: '620' });
      assert.equal(created.url, 'https://store.steampowered.com/app/620/');
      assert.equal(seen[0], tenant);
      assert.match(seen[1]!, /FROM marketrift.products WHERE id = \$2/);
    } else {
      await assert.rejects(controller.createSteamSource({} as Request,
        { product_id: product, app: '620' }), { status: 403 });
      assert.equal(seen.length, 0);
    }
  }
});

test('Steam sync rejects limits and invisible tenant source', async () => {
  const accounts = { principal: async (_request: Request, allowed: Role[]) => {
    assert.ok(allowed.includes('analyst')); return { tenantId: tenant, role: 'analyst' };
  } } as unknown as Accounts;
  const db = { tenant: async (_tenantId: string, callback: (client: object) => Promise<unknown>) =>
    callback({}), rows: async () => [] } as unknown as Db;
  const controller = new ApiController(db, {} as Jobs, accounts);
  await assert.rejects(controller.syncSource({} as Request, source, { max_pages: 1, max_items: 5 }), { status: 404 });
  await assert.rejects(controller.syncSource({} as Request, source, { max_pages: 4, max_items: 5 }), { status: 400 });
});
