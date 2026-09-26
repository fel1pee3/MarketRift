import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import test from 'node:test';

test('development scheduler entry loads Nest parameter decorators from the API workspace', async () => {
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
  let stdout = '';
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  try {
    await new Promise<void>((resolveWait, reject) => {
      const timeout = setTimeout(() => reject(new Error(`scheduler did not start: ${stderr}`)), 5000);
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
        if (stdout.includes('MarketRift scheduler started')) {
          clearTimeout(timeout); resolveWait();
        }
      });
      child.once('exit', () => { clearTimeout(timeout); reject(new Error(`scheduler exited: ${stderr}`)); });
    });
    assert.equal(child.exitCode, null, stderr);
    assert.equal(child.signalCode, null, stderr);
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
