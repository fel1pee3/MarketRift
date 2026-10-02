import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { externalConfig, preflight, publishBackup, publishJournal,
  putProtected, verifyReceipt } from './s3-object-lock.mjs';

const key = 'synthetic-laboratory-hmac-key-32-bytes';
function sha(body) { return createHash('sha256').update(body).digest('hex'); }
const config = { region:'us-east-1', bucket:'synthetic-locked-backups',
  anchorBucket:'synthetic-locked-anchors', prefix:'test-only',
  expectedAccount:'123456789012', expectedPrincipal:'arn:aws:iam::123456789012:role/read-only',
  retainUntil:'2099-01-01T00:00:00.000Z' };

class FakeS3 {
  objects = new Map(); versioning = true; objectLock = true;
  failUpload = false; failRead = false; shortRetention = false;
  async send(command) {
    const input = command.input;
    switch (command.constructor.name) {
      case 'GetBucketVersioningCommand': return { Status:this.versioning ? 'Enabled' : 'Suspended' };
      case 'GetObjectLockConfigurationCommand': return { ObjectLockConfiguration:
        { ObjectLockEnabled:this.objectLock ? 'Enabled' : 'Disabled' } };
      case 'ListObjectVersionsCommand': {
        const entries = [...this.objects.entries()]
          .filter(([k]) => k.startsWith(`${input.Bucket}/${input.Prefix}`))
          .map(([k,v]) => ({ Key:k.slice(input.Bucket.length + 1), VersionId:v.versionId }));
        return { Versions:entries, IsTruncated:false };
      }
      case 'PutObjectCommand': {
        if (this.failUpload) throw new Error('simulated transport failure');
        const target = `${input.Bucket}/${input.Key}`;
        if (this.objects.has(target)) throw new Error('simulated precondition failure');
        const chunks = [];
        if (Buffer.isBuffer(input.Body)) chunks.push(input.Body);
        else for await (const chunk of input.Body) chunks.push(chunk);
        const body = Buffer.concat(chunks);
        assert.equal(body.length, input.ContentLength);
        assert.equal(sha(body), Buffer.from(input.ChecksumSHA256, 'base64').toString('hex'));
        assert.equal(input.ObjectLockMode, 'COMPLIANCE');
        assert.equal(input.IfNoneMatch, '*');
        const versionId = `synthetic-version-${this.objects.size + 1}`;
        this.objects.set(target, { body, versionId });
        return { VersionId:versionId };
      }
      case 'GetObjectRetentionCommand': {
        const object = this.objects.get(`${input.Bucket}/${input.Key}`);
        if (!object || object.versionId !== input.VersionId) throw new Error('missing');
        return { Retention:{ Mode:'COMPLIANCE', RetainUntilDate:
          new Date(this.shortRetention ? '2030-01-01' : config.retainUntil) } };
      }
      case 'GetObjectCommand': {
        const object = this.objects.get(`${input.Bucket}/${input.Key}`);
        if (!object || object.versionId !== input.VersionId) throw new Error('missing');
        const body = this.failRead ? Buffer.from('tampered') : object.body;
        return { VersionId:object.versionId, Body:(async function* () { yield body; })() };
      }
      default: throw new Error(`unexpected command ${command.constructor.name}`);
    }
  }
}
function clients(s3) { return { s3, sts:{ send:async () => ({ Account:config.expectedAccount,
  Arn:config.expectedPrincipal }) } }; }

test('disabled by default and incomplete configuration fails before connecting', () => {
  assert.equal(externalConfig({}), null);
  assert.throws(() => externalConfig({ BACKUP_EXTERNAL_BACKEND:'s3-object-lock' }),
    /external_configuration_incomplete/);
});

test('read-only preflight rejects wrong identity and disabled bucket protections', async () => {
  const s3 = new FakeS3();
  s3.versioning = false;
  const wrong = { s3, sts:{ send:async () => ({ Account:config.expectedAccount,
    Arn:'arn:aws:iam::123456789012:role/unexpected' }) } };
  const report = await preflight(config, wrong, 0);
  assert.equal(report.status, 'blocked');
  assert.equal(report.checks.find(x => x.name === 'identity').status, 'failed');
  assert.equal(report.checks.find(x => x.name === 'backup_bucket').status, 'failed');
  assert.equal(report.checks.find(x => x.name === 'least_privilege_policy').status, 'pending');
});

test('versioned upload, exact read, swapped version, missing object and retention', async () => {
  const s3 = new FakeS3();
  const receipt = await putProtected(config, clients(s3), 'journal', '000000000001',
    Buffer.from('synthetic event'));
  assert.equal(await verifyReceipt(config, clients(s3), receipt), true);
  await assert.rejects(verifyReceipt(config, clients(s3),
    { ...receipt, versionId:'swapped' }), /external_version_unexpected/);
  s3.shortRetention = true;
  await assert.rejects(verifyReceipt(config, clients(s3), receipt),
    /external_retention_insufficient/);
  s3.shortRetention = false; s3.failRead = true;
  await assert.rejects(verifyReceipt(config, clients(s3), receipt),
    /external_checksum_mismatch/);
  s3.failRead = false;
  s3.objects.delete(`${receipt.bucket}/${receipt.key}`);
  await assert.rejects(verifyReceipt(config, clients(s3), receipt),
    /external_version_unexpected/);
});

test('upload failure fails closed and does not create an anchor', async () => {
  const s3 = new FakeS3(); s3.failUpload = true;
  await assert.rejects(putProtected(config, clients(s3), 'anchor', '000000000001',
    Buffer.from('synthetic')), /simulated transport failure/);
  assert.equal(s3.objects.size, 0);
});

test('journal anchor detects truncation, invalid signature, missing event and version', async () => {
  const s3 = new FakeS3();
  const root = resolve('.tmp'); mkdirSync(root,{ recursive:true });
  const dir = mkdtempSync(join(root,'external-journal-test-'));
  const tenant = '11111111-1111-4111-8111-111111111111';
  const source = '22222222-2222-4222-8222-222222222222';
  const event = { version:2, sequence:1, kind:'b2b_source', tenant_id:tenant,
    source_id:source, previous_signature:'0'.repeat(64), recorded_at:'2026-01-01T00:00:00Z' };
  const signature = createHmac('sha256',key).update(JSON.stringify(event)).digest('hex');
  writeFileSync(join(dir,`000000000001-b2b_source-${tenant}-${source}.json`),
    JSON.stringify({ event, signature }));
  try {
    const published = await publishJournal(config, clients(s3), dir, key, () => [event]);
    assert.equal(published.sequence, 1);
    const good = await preflight(config, clients(s3), 1, published.anchor_sha256, key);
    assert.equal(good.checks.find(x => x.name === 'anchor_continuity').status, 'passed');
    assert.equal(good.status, 'blocked');
    assert.equal((await preflight(config, clients(s3), 1, 'f'.repeat(64), key))
      .checks.find(x => x.name === 'anchor_continuity').reason,
      'external_checkpoint_mismatch');
    assert.equal((await preflight(config, clients(s3), 2, published.anchor_sha256, key))
      .checks.find(x => x.name === 'anchor_continuity').reason,
      'external_anchor_sequence_incomplete');
    const anchor = s3.objects.get(`${config.anchorBucket}/${config.prefix}/anchor/000000000001`);
    const originalAnchor = anchor.body;
    anchor.body = Buffer.from(anchor.body.toString().replace('signature', 'changed'));
    assert.equal((await preflight(config, clients(s3), 1, published.anchor_sha256, key))
      .checks.find(x => x.name === 'anchor_continuity').reason,'external_anchor_invalid');
    anchor.body = originalAnchor;
    s3.objects.delete(`${config.bucket}/${config.prefix}/journal/000000000001`);
    assert.equal((await preflight(config, clients(s3), 1, published.anchor_sha256, key))
      .checks.find(x => x.name === 'anchor_continuity').reason,
      'external_journal_version_missing');
  } finally { rmSync(dir,{ recursive:true, force:true }); }
});

test('backup and signed manifest are uploaded as distinct protected versions', async () => {
  const s3 = new FakeS3();
  const root = resolve('.tmp'); mkdirSync(root,{ recursive:true });
  const dir = mkdtempSync(join(root,'external-backup-test-'));
  const archive = join(dir,'synthetic.dump');
  const body = Buffer.from('synthetic backup content only');
  writeFileSync(archive,body);
  const manifest = { version:1, database:'marketrift_backup_lab_test',
    bytes:body.length, sha256:sha(body), journal_baseline:0 };
  const signature = createHmac('sha256',key).update(JSON.stringify(manifest)).digest('hex');
  writeFileSync(`${archive}.manifest.json`,JSON.stringify({ manifest,signature }));
  try {
    const receipts = await publishBackup(config, clients(s3), archive, key, 0);
    assert.equal(receipts.backup.sha256,sha(body));
    assert.equal(await verifyReceipt(config,clients(s3),receipts.manifest),true);
    const repeated = await publishBackup(config, clients(s3), archive, key, 0);
    assert.equal(repeated.backup.versionId, receipts.backup.versionId);
    assert.equal(s3.objects.size, 2);
  } finally { rmSync(dir,{ recursive:true, force:true }); }
});
