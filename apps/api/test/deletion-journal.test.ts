import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve, join, sep } from 'node:path';
import test from 'node:test';
import { readDeletionJournal, recordDeletion } from '../src/deletion-journal';

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
