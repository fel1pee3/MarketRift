import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

if (!process.env.DATABASE_ADMIN_URL || !process.env.RUNTIME_DATABASE_URL) throw new Error('Database URLs are required');
const python = process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python';
const testTempDir = resolve('.tmp', 'pytest');
mkdirSync(testTempDir, { recursive: true });
const result = spawnSync(python, ['-m', 'pytest', '-q', '-p', 'no:cacheprovider'], {
  cwd: 'apps/intelligence',
  env: { ...process.env, TEST_DATABASE_ADMIN_URL: process.env.DATABASE_ADMIN_URL,
    TMP: testTempDir, TEMP: testTempDir, TMPDIR: testTempDir },
  stdio: 'inherit',
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
