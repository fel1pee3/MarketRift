import { spawnSync } from 'node:child_process';

if (!process.env.DATABASE_ADMIN_URL || !process.env.RUNTIME_DATABASE_URL) throw new Error('Database URLs are required');
const python = process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python';
const result = spawnSync(python, ['-m', 'pytest', '-q', '-p', 'no:cacheprovider'], {
  cwd: 'apps/intelligence',
  env: { ...process.env, TEST_DATABASE_ADMIN_URL: process.env.DATABASE_ADMIN_URL },
  stdio: 'inherit',
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
