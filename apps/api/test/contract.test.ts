import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import test from 'node:test';
import { makeJob } from '../src/job';

test('TypeScript producer payload is accepted by Python consumer contract', () => {
  const job = makeJob(
    'b522d3cb-556c-46f3-bca3-a4d9a3a75e69',
    'e8f28408-d57b-4839-989b-f519550c8e0d',
    '79d47c62-9f2e-4dd6-97db-abdbbbfd7660',
  );
  assert.deepEqual(Object.keys(job).sort(), ['idempotency_key', 'import_id', 'source_id', 'tenant_id', 'version']);
  const python = join(__dirname, '../../intelligence/.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const result = spawnSync(python, ['-m', 'marketrift_intelligence.contract_cli'], {
    input: JSON.stringify(job), encoding: 'utf8', cwd: join(__dirname, '../../intelligence'),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'valid');
});
