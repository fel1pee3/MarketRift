import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import test from 'node:test';
import { schedulerErrorLabel } from '../src/scheduler-error';

test('scheduler diagnostics expose SQLSTATE without leaking connection details', () => {
  const failure = { name: 'error', code: '42501',
    message: 'permission denied; password=example-secret; postgres://user:secret@localhost/db' };
  assert.equal(schedulerErrorLabel(failure), 'PostgreSQL: permissão insuficiente (SQLSTATE 42501)');
  assert.equal(schedulerErrorLabel({ name: 'error', code: '42P01' }),
    'PostgreSQL: tabela ausente (SQLSTATE 42P01)');
  assert.doesNotMatch(schedulerErrorLabel(failure), /secret|postgres:\/\//);
});

test('development scheduler loads Nest decorators and fails closed when its database is unavailable', async () => {
  const apiDirectory = resolve(__dirname, '..');
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/page-scheduler-main.ts'], {
    cwd: apiDirectory,
    env: { ...process.env,
      MARKETRIFT_TEST_MODE: '1',
      PAGE_SCHEDULER_TEST_TENANT_ID: '00000000-0000-4000-8000-000000000000',
      PAGE_SCHEDULER_TEST_POLL_MS: '200',
      PROVISION_DATABASE_URL: 'postgres://test:test@127.0.0.1:1/test',
      RUNTIME_DATABASE_URL: 'postgres://test:test@127.0.0.1:1/test',
      REDIS_URL: 'redis://127.0.0.1:1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  try {
    await new Promise<void>((resolveWait, reject) => {
      const timeout = setTimeout(() => reject(new Error('scheduler did not stop')), 12000);
      child.stdout.resume();
      child.once('exit', () => { clearTimeout(timeout); resolveWait(); });
    });
    assert.notEqual(child.exitCode, 0);
    assert.match(stderr, /restore_unavailable/);
    assert.equal(stderr.includes('Parameter decorators only work'), false, stderr);
  } finally {
    child.kill();
    await new Promise<void>(resolveWait => {
      if (child.exitCode !== null) { resolveWait(); return; }
      const timeout = setTimeout(() => { child.kill('SIGKILL'); resolveWait(); }, 2000);
      child.once('exit', () => { clearTimeout(timeout); resolveWait(); });
    });
  }
});
