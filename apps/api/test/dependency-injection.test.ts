import assert from 'node:assert/strict';
import test from 'node:test';
import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ApiController } from '../src/routes';
import { Db } from '../src/db';
import { Jobs } from '../src/queue';

const userId = '79d47c62-9f2e-4dd6-97db-abdbbbfd7660';
const tenantId = 'b522d3cb-556c-46f3-bca3-a4d9a3a75e69';
const queries: string[] = [];
const client = {
  query: async (sql: string) => {
    queries.push(sql);
    if (sql.includes('INSERT INTO marketrift.users')) return { rows: [{ id: userId }] };
    if (sql.includes('INSERT INTO marketrift.tenants')) return { rows: [{ id: tenantId }] };
    return { rows: [] };
  },
  release: () => {},
};
const db = { provisioning: { connect: async () => client } };

@Module({ controllers: [ApiController], providers: [
  { provide: Db, useValue: db },
  { provide: Jobs, useValue: {} },
] })
class TestModule {}

test('Nest injects controller dependencies when loaded with tsx in development', async () => {
  process.env.JWT_SECRET = 'test-secret-that-is-at-least-32-characters';
  const app = await NestFactory.createApplicationContext(TestModule, { logger: false });
  try {
    const response = await app.get(ApiController).register({
      email: 'developer@example.com',
      password: 'test-password-12345',
      display_name: 'Developer',
      company_name: 'Example',
    });
    assert.equal(response.tenant_id, tenantId);
    assert.equal(typeof response.token, 'string');
    assert.deepEqual(queries.map(sql => sql.split(' ')[0]), ['BEGIN', 'INSERT', 'INSERT', 'INSERT', 'COMMIT']);
  } finally {
    await app.close();
  }
});
