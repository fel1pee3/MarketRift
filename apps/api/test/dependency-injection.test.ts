import assert from 'node:assert/strict';
import test from 'node:test';
import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ApiController } from '../src/routes';
import { Accounts, AccountsController } from '../src/accounts';
import { Db } from '../src/db';
import { Jobs } from '../src/queue';
import type { Request } from 'express';

const tenantId = 'b522d3cb-556c-46f3-bca3-a4d9a3a75e69';
const userId = '79d47c62-9f2e-4dd6-97db-abdbbbfd7660';
const raw = 'a'.repeat(64);
process.env.JWT_SECRET = 'test-secret-that-is-at-least-32-characters';
const db = {
  provisioning: { query: async (sql: string) => {
    if (sql.includes('browser_sessions')) return { rows: [{ id: 'session-id', user_id: userId, tenant_id: tenantId, email: 'user@example.com' }] };
    if (sql.includes('display_name')) return { rows: [{ email: 'user@example.com', display_name: 'Test User' }] };
    return { rows: [{ tenant_id: tenantId, name: 'Test Company', role: 'owner' }] };
  } },
  tenant: async (_tenantId: string, work: (client: object) => Promise<unknown>) => work({}),
  rows: async () => [{ role: 'owner' }],
};

@Module({ controllers: [ApiController, AccountsController], providers: [
  { provide: Db, useValue: db }, { provide: Jobs, useValue: {} }, Accounts,
] })
class TestModule {}

test('Nest injects account service into both controllers under tsx development loader', async () => {
  const app = await NestFactory.createApplicationContext(TestModule, { logger: false });
  try {
    const request = { method: 'GET', headers: { cookie: `marketrift_session=${raw}` } } as Request;
    const principal = await app.get(ApiController).me(request);
    assert.equal(principal.userId, userId);
    assert.equal(principal.tenantId, tenantId);
    const session = await app.get(AccountsController).session(request);
    assert.equal(session.email, 'user@example.com');
    assert.equal(session.role, 'owner');
    assert.equal(session.csrf_token.length, 64);
  } finally { await app.close(); }
});
