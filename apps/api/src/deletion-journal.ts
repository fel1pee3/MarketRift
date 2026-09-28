import { createHmac, timingSafeEqual } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, readdirSync,
  renameSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';

export type DeletionEvent = {
  version: 2;
  sequence: number;
  previous_signature: string;
  kind: 'b2b_review' | 'b2b_source';
  tenant_id: string;
  source_id: string;
  document_id?: string;
  external_key_hmac?: string;
  recorded_at: string;
};
type SignedEvent = { event: DeletionEvent; signature: string };
type Head = { version: 2; sequence: number; signature: string };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const hex = /^[0-9a-f]{64}$/;
const ZERO = '0'.repeat(64);

function configuration(): { directory: string; key: string } | null {
  const directory = process.env.BACKUP_DELETION_JOURNAL_DIR;
  const key = process.env.BACKUP_DELETION_JOURNAL_KEY;
  if (!directory && !key) return null;
  if (!directory || !key || key.length < 32)
    throw new Error('Deletion journal configuration incomplete');
  return { directory, key };
}

export function externalKeyHmac(key: string, externalKey: string): string {
  return createHmac('sha256', key).update(externalKey).digest('hex');
}

function hmac(key: string, value: unknown): string {
  return createHmac('sha256', key).update(JSON.stringify(value)).digest('hex');
}

function equalHex(left: string, right: string): boolean {
  return hex.test(left) && hex.test(right) &&
    timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function eventName(event: DeletionEvent): string {
  return `${String(event.sequence).padStart(12, '0')}-${event.kind}-${event.tenant_id}`
    + `-${event.source_id}${event.document_id ? `-${event.document_id}` : ''}.json`;
}

function writeDurable(path: string, value: unknown): void {
  const fd = openSync(path, 'wx', 0o600);
  try { writeSync(fd, JSON.stringify(value)); fsyncSync(fd); }
  finally { closeSync(fd); }
}

export function readDeletionJournal(directory: string, key: string): DeletionEvent[] {
  const names = readdirSync(directory).filter(name => name.endsWith('.json') && name !== 'head.json');
  if (names.some(name => !/^\d{12}-.*\.json$/.test(name)))
    throw new Error('Deletion journal filename invalid');
  const files = names.sort();
  const headPath = join(directory, 'head.json');
  if (!existsSync(headPath)) {
    if (files.length) throw new Error('Deletion journal head missing');
    return [];
  }
  const head = JSON.parse(readFileSync(headPath, 'utf8')) as Head;
  if (head.version !== 2 || !Number.isSafeInteger(head.sequence) || head.sequence < 0 ||
      !hex.test(head.signature ?? '')) throw new Error('Deletion journal head invalid');
  if (head.sequence !== files.length) throw new Error('Deletion journal sequence gap');
  const events: DeletionEvent[] = [];
  let previous = ZERO;
  for (const [index, name] of files.entries()) {
    const signed = JSON.parse(readFileSync(join(directory, name), 'utf8')) as SignedEvent;
    const event = signed.event;
    if (!event || event.version !== 2 || event.sequence !== index + 1 ||
      event.previous_signature !== previous || !uuid.test(event.tenant_id) ||
      !uuid.test(event.source_id) || !['b2b_review', 'b2b_source'].includes(event.kind) ||
      (event.kind === 'b2b_review' && (!event.document_id || !uuid.test(event.document_id) ||
        !hex.test(event.external_key_hmac ?? ''))) ||
      name !== eventName(event) || !equalHex(signed.signature, hmac(key, event)))
      throw new Error('Deletion journal event invalid');
    previous = signed.signature;
    events.push(event);
  }
  if (!equalHex(head.signature, hmac(key,
    { version: 2, sequence: head.sequence, previous_signature: previous })))
    throw new Error('Deletion journal head invalid');
  return events;
}

/** A rolled-back deletion may conservatively remain in this journal. */
export function recordDeletion(kind: 'b2b_review' | 'b2b_source', tenantId: string,
  sourceId: string, documentId?: string, externalKey?: string): boolean {
  const config = configuration();
  if (!config) return false;
  if (!uuid.test(tenantId) || !uuid.test(sourceId) ||
      (kind === 'b2b_review' && (!documentId || !uuid.test(documentId) || !externalKey)))
    throw new Error('Deletion journal identifiers invalid');
  const lock = join(config.directory, '.journal-lock');
  const lockFd = openSync(lock, 'wx', 0o600); // Collision or stale lock fails closed.
  try {
    const events = readDeletionJournal(config.directory, config.key);
    const existing = events.find(event => event.kind === kind && event.tenant_id === tenantId &&
      event.source_id === sourceId && (kind === 'b2b_source' || event.document_id === documentId));
    if (existing) {
      if (kind === 'b2b_review' &&
          existing.external_key_hmac !== externalKeyHmac(config.key, externalKey!))
        throw new Error('Deletion journal conflict');
      return true;
    }
    const sequence = events.length + 1;
    const previousSignature = events.length ? hmac(config.key, events[events.length - 1]) : ZERO;
    const event: DeletionEvent = { version: 2, sequence, previous_signature: previousSignature,
      kind, tenant_id: tenantId, source_id: sourceId,
      ...(documentId ? { document_id: documentId } : {}),
      ...(externalKey ? { external_key_hmac: externalKeyHmac(config.key, externalKey) } : {}),
      recorded_at: new Date().toISOString() };
    const signature = hmac(config.key, event);
    writeDurable(join(config.directory, eventName(event)), { event, signature });
    const tempHead = join(config.directory, `head-${process.pid}.tmp`);
    writeDurable(tempHead, { version: 2, sequence,
      signature: hmac(config.key, { version: 2, sequence, previous_signature: signature }) });
    renameSync(tempHead, join(config.directory, 'head.json'));
    return true;
  } finally { closeSync(lockFd); unlinkSync(lock); }
}
