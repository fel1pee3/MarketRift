import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import test from 'node:test';
import type { Request } from 'express';
import { Accounts, Role } from '../src/accounts';
import { Db } from '../src/db';
import { Jobs } from '../src/queue';
import { makeWebPageJob } from '../src/web-page-job';
import { publicPageUrl } from '../src/web-page-url';
import { WebPagesController } from '../src/web-pages';

const tenant = 'b522d3cb-556c-46f3-bca3-a4d9a3a75e69';
const product = 'e8f28408-d57b-4839-989b-f519550c8e0d';
const source = '79d47c62-9f2e-4dd6-97db-abdbbbfd7660';

test('page URL validation blocks internal hosts, credentials, queries and ports', () => {
  assert.equal(publicPageUrl('https://example.com/pricing#top'), 'https://example.com/pricing');
  for (const url of ['http://example.com/pricing', 'https://127.0.0.1/', 'https://localhost/',
    'https://169.254.169.254/latest/meta-data/', 'https://user:pass@example.com/',
    'https://example.com:8443/pricing', 'https://example.com/?token=x',
    'https://api.internal/pricing', 'https://example.invalid/pricing']) {
    assert.throws(() => publicPageUrl(url));
  }
});

test('TypeScript page job is accepted by Python worker contract', () => {
  const job = makeWebPageJob(tenant, source, product);
  const python = join(__dirname, '../../intelligence/.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const result = spawnSync(python, ['-m', 'marketrift_intelligence.web_page_contract_cli'], {
    input: JSON.stringify(job), encoding: 'utf8', cwd: join(__dirname, '../../intelligence'),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'valid');
});

test('only owner/admin create; analyst checks; viewer only reads', async () => {
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
      return [{ id: source, product_id: product, url: args[3] }];
    } } as unknown as Db;
    const controller = new WebPagesController(db, {} as Jobs, accounts);
    if (role === 'owner' || role === 'admin') {
      await controller.create({} as Request, { product_id: product, source_type: 'pricing_page',
        url: 'https://example.com/pricing', check_interval_minutes: 1440 });
      assert.equal(seen[0], tenant);
      assert.match(seen[1]!, /FROM marketrift.products WHERE tenant_id = \$1 AND id = \$2/);
    } else {
      await assert.rejects(controller.create({} as Request, { product_id: product, source_type: 'pricing_page',
        url: 'https://example.com/pricing', check_interval_minutes: 1440 }), { status: 403 });
      assert.equal(seen.length, 0);
    }
  }
});

test('invisible source cannot be checked and viewer cannot request a job', async () => {
  const accounts = { principal: async (_request: Request, allowed: Role[]) => {
    if (!allowed.includes('analyst')) throw Object.assign(new Error('Forbidden'), { status: 403 });
    return { tenantId: tenant, role: 'analyst' };
  } } as unknown as Accounts;
  const db = { tenant: async (_tenantId: string, callback: (client: object) => Promise<unknown>) =>
    callback({}), rows: async () => [] } as unknown as Db;
  const controller = new WebPagesController(db, {} as Jobs, accounts);
  await assert.rejects(controller.check({} as Request, source), { status: 404 });
  await assert.rejects(controller.check({} as Request, 'wrong-id'), { status: 400 });
  const viewer = { principal: async () => { throw Object.assign(new Error('Forbidden'), { status: 403 }); } } as unknown as Accounts;
  await assert.rejects(new WebPagesController(db, {} as Jobs, viewer).check({} as Request, source), { status: 403 });
});
