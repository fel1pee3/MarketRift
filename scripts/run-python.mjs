import { spawn } from 'node:child_process';
import { join } from 'node:path';

const target = process.argv[2];
const args = target === 'worker'
  ? ['-m', 'marketrift_intelligence.worker']
  : target === 'http'
    ? ['-m', 'uvicorn', 'marketrift_intelligence.http:app', '--host', '127.0.0.1', '--port', '8000']
    : target === 'evaluate' && process.argv[3] === 'test'
      ? ['-m', 'marketrift_intelligence.evaluation', '--provider', process.argv[3]]
    : target === 'quality'
      ? ['-m', 'marketrift_intelligence.quality_cli', ...process.argv.slice(3)]
    : null;
if (!args) throw new Error('Expected worker, http, quality or evaluate test');
const python = join('apps', 'intelligence', '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const child = spawn(python, args, { env: process.env, stdio: 'inherit' });
for (const event of ['SIGINT', 'SIGTERM']) process.on(event, () => child.kill());
child.on('error', error => { console.error(error); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 0; });
