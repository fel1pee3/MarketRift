import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import test from 'node:test';
import { makeSteamJob } from '../src/steam-job';
import { steamAppId, steamSourceUrl } from '../src/steam-source';

test('Steam source accepts only App IDs and Steam product URLs', () => {
  assert.equal(steamAppId('620'), 620);
  assert.equal(steamAppId('https://store.steampowered.com/app/620/Portal_2/?snr=test'), 620);
  assert.equal(steamSourceUrl(620), 'https://store.steampowered.com/app/620/');
  for (const value of ['0', '-1', '4294967296', 'https://evil.test/app/620/',
    'http://store.steampowered.com/app/620/', 'https://store.steampowered.com/appreviews/620',
    'https://store.steampowered.com@evil.test/app/620/']) {
    assert.throws(() => steamAppId(value));
  }
});

test('TypeScript Steam job is accepted by Python consumer', () => {
  const job = makeSteamJob('b522d3cb-556c-46f3-bca3-a4d9a3a75e69',
    'e8f28408-d57b-4839-989b-f519550c8e0d', '79d47c62-9f2e-4dd6-97db-abdbbbfd7660');
  const python = join(__dirname, '../../intelligence/.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const result = spawnSync(python, ['-m', 'marketrift_intelligence.steam_contract_cli'], {
    input: JSON.stringify(job), encoding: 'utf8', cwd: join(__dirname, '../../intelligence'),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'valid');
});
