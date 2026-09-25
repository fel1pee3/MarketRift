import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import type { Request } from 'express';
import { ApiController } from '../src/routes';
import { canonicalGitHubRepository } from '../src/github-source';
import { makeGitHubDiscussionsJob } from '../src/github-discussions-job';
import { Db } from '../src/db';
import { Jobs } from '../src/queue';
import { Accounts, Role } from '../src/accounts';

const tenant = 'b522d3cb-556c-46f3-bca3-a4d9a3a75e69';
const product = 'e8f28408-d57b-4839-989b-f519550c8e0d';
const source = '79d47c62-9f2e-4dd6-97db-abdbbbfd7660';
const run = '97e7136f-76d7-44ee-9f5e-cdb405ed09c4';

test('Discussion jobs carry IDs only and repository URL is canonical', () => {
  assert.deepEqual(Object.keys(makeGitHubDiscussionsJob(tenant, source, run)).sort(),
    ['idempotency_key', 'run_id', 'source_id', 'tenant_id', 'version']);
  assert.equal(canonicalGitHubRepository('Example/Repo'), 'https://github.com/example/repo');
  assert.throws(() => canonicalGitHubRepository('https://127.0.0.1/repo/path'));
});

test('TypeScript Discussion job is accepted by Python consumer', () => {
  const python = join(__dirname, '../../intelligence/.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const result = spawnSync(python, ['-m', 'marketrift_intelligence.github_discussions_contract_cli'], {
    input: JSON.stringify(makeGitHubDiscussionsJob(tenant, source, run)), encoding: 'utf8',
    cwd: join(__dirname, '../../intelligence'),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'valid');
});

test('owner/admin create Discussion source inside active tenant; other roles cannot', async () => {
  for (const role of ['owner', 'admin', 'analyst', 'viewer'] as Role[]) {
    const sqls: string[] = [];
    const accounts = { principal: async (_request: Request, allowed: Role[]) => {
      if (!allowed.includes(role)) throw Object.assign(new Error('Forbidden'), { status: 403 });
      return { tenantId: tenant, role };
    } } as unknown as Accounts;
    const db = { tenant: async (id: string, callback: (client: object) => Promise<unknown>) => {
      assert.equal(id, tenant); return callback({});
    }, rows: async (_client: object, sql: string, args: unknown[]) => {
      sqls.push(sql); assert.deepEqual(args, [tenant, product, 'https://github.com/example/repo']);
      return [{ id: source, product_id: product, source_type: 'github_discussions', url: args[2] }];
    } } as unknown as Db;
    const controller = new ApiController(db, {} as Jobs, accounts);
    if (role === 'owner' || role === 'admin') {
      assert.equal((await controller.createDiscussionsSource({} as Request,
        { product_id: product, repository: 'Example/Repo' })).source_type, 'github_discussions');
      assert.match(sqls[0]!, /FROM marketrift.products WHERE id = \$2/);
    } else {
      await assert.rejects(controller.createDiscussionsSource({} as Request,
        { product_id: product, repository: 'Example/Repo' }), { status: 403 });
      assert.equal(sqls.length, 0);
    }
  }
});

test('analyst can request Discussion collection; viewer cannot; foreign source remains invisible', async () => {
  const db = { tenant: async (_id: string, callback: (client: object) => Promise<unknown>) => callback({}),
    rows: async () => [] } as unknown as Db;
  for (const role of ['analyst', 'viewer'] as Role[]) {
    const accounts = { principal: async (_request: Request, allowed: Role[]) => {
      if (!allowed.includes(role)) throw Object.assign(new Error('Forbidden'), { status: 403 });
      return { tenantId: tenant, role };
    } } as unknown as Accounts;
    const controller = new ApiController(db, {} as Jobs, accounts);
    await assert.rejects(controller.syncSource({} as Request, source,
      { max_pages: 1, max_items: 5 }), { status: role === 'viewer' ? 403 : 404 });
  }
});
