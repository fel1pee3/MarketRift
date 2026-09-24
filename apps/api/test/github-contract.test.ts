import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import test from 'node:test';
import { makeGitHubJob } from '../src/github-job';
import { canonicalGitHubRepository } from '../src/github-source';

test('repository input only accepts public github.com owner/repo', () => {
  assert.equal(canonicalGitHubRepository('Example/Repo'), 'https://github.com/example/repo');
  assert.equal(canonicalGitHubRepository('https://github.com/Example/Repo/'), 'https://github.com/example/repo');
  for (const value of ['https://evil.test/a/b', 'http://github.com/a/b', 'https://github.com/a/b/issues',
    'https://github.com/a/b?x=1', 'https://github.com@evil.test/a/b', '../repo']) {
    assert.throws(() => canonicalGitHubRepository(value));
  }
});

test('TypeScript GitHub job is accepted by the Python worker contract', () => {
  const job = makeGitHubJob('b522d3cb-556c-46f3-bca3-a4d9a3a75e69',
    'e8f28408-d57b-4839-989b-f519550c8e0d', '79d47c62-9f2e-4dd6-97db-abdbbbfd7660');
  const python = join(__dirname, '../../intelligence/.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const result = spawnSync(python, ['-m', 'marketrift_intelligence.github_contract_cli'], {
    input: JSON.stringify(job), encoding: 'utf8', cwd: join(__dirname, '../../intelligence'),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'valid');
});
