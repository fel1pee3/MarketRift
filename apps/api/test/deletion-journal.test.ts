import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve, join, sep } from 'node:path';
import test from 'node:test';
import { readDeletionJournal, recordDeletion, recordDeletionForOperation } from '../src/deletion-journal';

const tenant = '11111111-1111-4111-8111-111111111111';
const source = '22222222-2222-4222-8222-222222222222';
const document = '33333333-3333-4333-8333-333333333333';

test('B2B deletion journal contains IDs and an HMAC, rejects tampering and repeats safely', () => {
  const root = resolve('.tmp'); mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, 'journal-test-'));
  assert(dir.startsWith(root + sep));
  const oldDir = process.env.BACKUP_DELETION_JOURNAL_DIR;
  const oldKey = process.env.BACKUP_DELETION_JOURNAL_KEY;
  const key = 'synthetic-test-key-with-at-least-32-characters';
  process.env.BACKUP_DELETION_JOURNAL_DIR = dir;
  process.env.BACKUP_DELETION_JOURNAL_KEY = key;
  try {
    assert.equal(recordDeletion('b2b_review', tenant, source, document, 'private-review-key'), true);
    assert.equal(recordDeletion('b2b_review', tenant, source, document, 'private-review-key'), true);
    const events = readDeletionJournal(dir, key);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.external_key_hmac,
      createHmac('sha256', key).update('private-review-key').digest('hex'));
    const path = join(dir, `000000000001-b2b_review-${tenant}-${source}-${document}.json`);
    assert.equal(readFileSync(path, 'utf8').includes('private-review-key'), false);
    assert.equal(recordDeletion('b2b_source', tenant, source), true);
    const second = join(dir, `000000000002-b2b_source-${tenant}-${source}.json`);
    const firstContents = readFileSync(path, 'utf8');
    unlinkSync(path);
    assert.throws(() => readDeletionJournal(dir, key), /sequence gap/);
    // Restore the first event solely to test a changed signed payload.
    writeFileSync(path, firstContents);
    assert.equal(readFileSync(second, 'utf8').includes('private-review-key'), false);
    writeFileSync(path, readFileSync(path, 'utf8').replace(document, source));
    assert.throws(() => readDeletionJournal(dir, key), /Deletion journal event invalid/);
  } finally {
    if (oldDir === undefined) delete process.env.BACKUP_DELETION_JOURNAL_DIR;
    else process.env.BACKUP_DELETION_JOURNAL_DIR = oldDir;
    if (oldKey === undefined) delete process.env.BACKUP_DELETION_JOURNAL_KEY;
    else process.env.BACKUP_DELETION_JOURNAL_KEY = oldKey;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('external mode refuses a deletion before database work when destination is incomplete', async () => {
  const root = resolve('.tmp'); mkdirSync(root, { recursive:true });
  const dir = mkdtempSync(join(root, 'journal-external-test-'));
  const old = { dir:process.env.BACKUP_DELETION_JOURNAL_DIR,
    key:process.env.BACKUP_DELETION_JOURNAL_KEY,
    backend:process.env.BACKUP_EXTERNAL_BACKEND };
  process.env.BACKUP_DELETION_JOURNAL_DIR = dir;
  process.env.BACKUP_DELETION_JOURNAL_KEY = 'synthetic-test-key-with-at-least-32-characters';
  process.env.BACKUP_EXTERNAL_BACKEND = 's3-object-lock';
  try {
    await assert.rejects(recordDeletionForOperation('b2b_source', tenant, source),
      /external_configuration_incomplete/);
    // Local write is conservative; retry can publish it after configuration is fixed.
    assert.equal(readDeletionJournal(dir, process.env.BACKUP_DELETION_JOURNAL_KEY).length, 1);
  } finally {
    for (const [name,value] of [
      ['BACKUP_DELETION_JOURNAL_DIR',old.dir],
      ['BACKUP_DELETION_JOURNAL_KEY',old.key],
      ['BACKUP_EXTERNAL_BACKEND',old.backend]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(dir,{ recursive:true, force:true });
  }
});
