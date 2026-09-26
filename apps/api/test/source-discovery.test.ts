import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import test from 'node:test';
import { makeDiscoveryJob } from '../src/source-discovery-job';
import { officialDomain } from '../src/source-discovery';

test('official domain is normalized and unsafe destinations are rejected', () => {
  assert.equal(officialDomain('EXAMPLE.com'), 'example.com');
  assert.equal(officialDomain('https://www.example.com/'), 'www.example.com');
  for (const value of ['http://example.com', 'https://example.com/pricing', '127.0.0.1',
    'localhost', '169.254.169.254', 'example.internal', 'https://example.com?token=x',
    'https://example.com:8443', 'https://user:pass@example.com']) {
    assert.throws(() => officialDomain(value));
  }
});

test('TypeScript discovery job is accepted by the Python worker contract', () => {
  const job = makeDiscoveryJob('b522d3cb-556c-46f3-bca3-a4d9a3a75e69',
    'e8f28408-d57b-4839-989b-f519550c8e0d', '79d47c62-9f2e-4dd6-97db-abdbbbfd7660', 2);
  const python = join(__dirname, '../../intelligence/.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const result = spawnSync(python, ['-c',
    'import json,sys; from marketrift_intelligence.source_discovery import validate_job; validate_job(json.load(sys.stdin)); print("valid")'], {
    input: JSON.stringify(job), encoding: 'utf8', cwd: join(__dirname, '../../intelligence'),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'valid');
});
