import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream, readFileSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { pipeline } from 'node:stream/promises';

const image = 'pgvector/pgvector:pg16';
const safeName = /^[a-z][a-z0-9_-]{2,80}$/;

export function docker(args) {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 60_000, maxBuffer: 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error('docker_command_failed');
  return result.stdout.trim();
}

export function startLabContainer(name, password, database) {
  if (!safeName.test(name) || !safeName.test(database)) throw new Error('invalid_lab_name');
  docker(['run', '--detach', '--rm', '--name', name, '--publish', '127.0.0.1::5432',
    '--env', `POSTGRES_PASSWORD=${password}`, '--env', `POSTGRES_DB=${database}`, image]);
  const port = docker(['port', name, '5432/tcp']).match(/127\.0\.0\.1:(\d+)/)?.[1];
  if (!port) throw new Error('lab_port_unavailable');
  return Number(port);
}

export function startLabRedis(name) {
  if (!safeName.test(name) || !name.startsWith('marketrift-backup-lab-'))
    throw new Error('invalid_lab_name');
  docker(['run', '--detach', '--rm', '--name', name, '--publish', '127.0.0.1::6379', 'redis:7-alpine']);
  const port = docker(['port', name, '6379/tcp']).match(/127\.0\.0\.1:(\d+)/)?.[1];
  if (!port) throw new Error('lab_port_unavailable');
  return Number(port);
}

export function stopLabContainer(name) {
  if (!name.startsWith('marketrift-backup-lab-') || !safeName.test(name))
    throw new Error('refusing_to_stop_unrelated_container');
  docker(['stop', name]);
}

async function streamDocker(args, { inputFile, outputFile, inputText } = {}) {
  const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderrBytes = 0;
  child.stderr.on('data', chunk => { stderrBytes += chunk.length; });
  const tasks = [];
  if (inputFile) tasks.push(pipeline(createReadStream(inputFile), child.stdin));
  else if (inputText !== undefined) child.stdin.end(inputText);
  else child.stdin.end();
  if (outputFile) tasks.push(pipeline(child.stdout,
    createWriteStream(outputFile, { flags: 'wx', mode: 0o600 })));
  else child.stdout.resume();
  const close = new Promise((resolve, reject) => {
    child.once('error', () => reject(new Error('docker_spawn_failed')));
    child.once('close', code => code === 0 ? resolve() :
      reject(new Error(`docker_exit_${code ?? 'unknown'}_stderr_bytes_${stderrBytes}`)));
  });
  await Promise.all([...tasks, close]);
}

async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function sign(key, value) {
  return createHmac('sha256', key).update(JSON.stringify(value)).digest('hex');
}

export async function backup(container, database, archivePath, key, baseline = 0) {
  if (!safeName.test(container) || !safeName.test(database)) throw new Error('invalid_backup_target');
  await streamDocker(['exec', container, 'pg_dump', '-U', 'postgres', '-d', database,
    '--format=custom', '--no-owner'], { outputFile: archivePath });
  const { size } = await import('node:fs/promises').then(fs => fs.stat(archivePath));
  const manifest = { version: 1, database, created_at: new Date().toISOString(),
    bytes: size, sha256: await sha256(archivePath), journal_baseline: baseline };
  writeFileSync(`${archivePath}.manifest.json`, JSON.stringify({ manifest,
    signature: sign(key, manifest) }), { flag: 'wx', mode: 0o600 });
  return manifest;
}

export async function verify(container, archivePath, key) {
  const envelope = JSON.parse(readFileSync(`${archivePath}.manifest.json`, 'utf8'));
  const manifest = envelope.manifest;
  if (!manifest || manifest.version !== 1 || !safeName.test(manifest.database) ||
      !/^[0-9a-f]{64}$/.test(envelope.signature ?? '')) throw new Error('verification_failed_manifest');
  const expected = Buffer.from(sign(key, manifest), 'hex');
  if (!timingSafeEqual(expected, Buffer.from(envelope.signature, 'hex')))
    throw new Error('verification_failed_signature');
  const { size } = await import('node:fs/promises').then(fs => fs.stat(archivePath));
  if (size !== manifest.bytes || await sha256(archivePath) !== manifest.sha256)
    throw new Error('verification_failed_checksum');
  await streamDocker(['exec', '--interactive', container, 'pg_restore', '--list'],
    { inputFile: archivePath });
  return manifest;
}

export async function restore(container, archivePath, key, loginPasswords) {
  const manifest = await verify(container, archivePath, key);
  if (!loginPasswords || !/^[0-9a-f]{48}$/.test(loginPasswords.runtime) ||
      !/^[0-9a-f]{48}$/.test(loginPasswords.provision))
    throw new Error('restore_logins_required');
  await streamDocker(['exec', '--interactive', container, 'psql', '-U', 'postgres',
    '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'], { inputText:
    'CREATE ROLE marketrift_runtime NOLOGIN NOSUPERUSER NOBYPASSRLS;\n'
    + 'CREATE ROLE marketrift_provisioner NOLOGIN NOSUPERUSER NOBYPASSRLS;\n'
    + `CREATE TABLE public.marketrift_restore_gate (id boolean PRIMARY KEY DEFAULT true CHECK(id),
       database_name text NOT NULL, archive_sha256 text NOT NULL, state text NOT NULL
       CHECK(state IN ('quarantined','released')), audit_digest text, audit_sequence bigint,
       audited_at timestamptz, audited_by text, released_at timestamptz, released_by text);\n`
    + `CREATE TABLE public.marketrift_restore_gate_events (
       id bigserial PRIMARY KEY, kind text NOT NULL CHECK(kind IN ('audited','released')),
       audit_digest text NOT NULL, operator_id text NOT NULL, occurred_at timestamptz NOT NULL DEFAULT now(),
       UNIQUE(kind,audit_digest));\n`
    + `INSERT INTO public.marketrift_restore_gate(id,database_name,archive_sha256,state)
       VALUES(true,'${manifest.database}','${manifest.sha256}','quarantined');\n`
    + 'REVOKE ALL ON public.marketrift_restore_gate FROM PUBLIC;\n'
    + 'GRANT SELECT ON public.marketrift_restore_gate TO marketrift_runtime, marketrift_provisioner;\n' });
  await streamDocker(['exec', '--interactive', container, 'pg_restore', '-U', 'postgres',
    '-d', 'postgres', '--create', '--no-owner', '--exit-on-error'],
  { inputFile: archivePath });
  await streamDocker(['exec', '--interactive', container, 'psql', '-U', 'postgres',
    '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'], { inputText:
    `REVOKE CONNECT ON DATABASE ${manifest.database} FROM PUBLIC,
       marketrift_runtime, marketrift_provisioner;\n`
    + `CREATE ROLE marketrift_api_login LOGIN INHERIT PASSWORD '${loginPasswords.runtime}';\n`
    + `CREATE ROLE marketrift_auth_login LOGIN INHERIT PASSWORD '${loginPasswords.provision}';\n`
    + 'GRANT marketrift_runtime TO marketrift_api_login;\n'
    + 'GRANT marketrift_provisioner TO marketrift_auth_login;\n' });
  return manifest;
}
