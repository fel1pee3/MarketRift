/** Optional S3 Object Lock transport. No client is constructed until explicitly called. */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { createReadStream, readFileSync, statSync } from 'node:fs';
import { GetBucketVersioningCommand, GetObjectLockConfigurationCommand,
  GetObjectCommand, GetObjectRetentionCommand, ListObjectVersionsCommand,
  PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { NodeHttpHandler } from '@smithy/node-http-handler';

const hex = /^[0-9a-f]{64}$/;
const bucketName = /^[a-z0-9][a-z0-9.-]{2,62}$/;
const prefixName = /^[a-zA-Z0-9][a-zA-Z0-9/_-]{0,120}$/;

export function externalConfig(env = process.env) {
  if (!env.BACKUP_EXTERNAL_BACKEND) return null;
  if (env.BACKUP_EXTERNAL_BACKEND !== 's3-object-lock')
    throw new Error('external_backend_unsupported');
  const config = { region: env.BACKUP_S3_REGION, bucket: env.BACKUP_S3_BUCKET,
    anchorBucket: env.BACKUP_S3_ANCHOR_BUCKET, prefix: env.BACKUP_S3_PREFIX,
    expectedAccount: env.BACKUP_S3_EXPECTED_ACCOUNT,
    expectedPrincipal: env.BACKUP_S3_EXPECTED_PRINCIPAL,
    retainUntil: env.BACKUP_S3_RETAIN_UNTIL };
  if (!config.region || !/^[a-z]{2}-[a-z]+-\d$/.test(config.region) ||
      !bucketName.test(config.bucket ?? '') || !bucketName.test(config.anchorBucket ?? '') ||
      config.bucket === config.anchorBucket || !prefixName.test(config.prefix ?? '') ||
      !/^\d{12}$/.test(config.expectedAccount ?? '') ||
      !config.expectedPrincipal || !/^arn:aws(-[a-z]+)?:/.test(config.expectedPrincipal) ||
      !config.retainUntil || Number.isNaN(Date.parse(config.retainUntil)) ||
      Date.parse(config.retainUntil) <= Date.now())
    throw new Error('external_configuration_incomplete');
  return config;
}

export function awsClients(config) {
  const s3Handler = new NodeHttpHandler({ connectionTimeout: 2_000,
    requestTimeout: 60_000 });
  const stsHandler = new NodeHttpHandler({ connectionTimeout: 2_000,
    requestTimeout: 10_000 });
  return { s3: new S3Client({ region: config.region, maxAttempts: 2,
    requestHandler:s3Handler }),
    sts: new STSClient({ region: config.region, maxAttempts: 2,
      requestHandler:stsHandler }) };
}

function sha(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function safeKey(config, kind, id) {
  if (!['backup', 'manifest', 'journal', 'anchor'].includes(kind) ||
      !/^[a-zA-Z0-9_-]{1,120}$/.test(id)) throw new Error('external_object_key_invalid');
  return `${config.prefix}/${kind}/${id}`;
}
function owner(config) { return { ExpectedBucketOwner: config.expectedAccount }; }
function result(name, passed, reason) { return { name, status: passed ? 'passed' : 'failed', ...(reason ? { reason } : {}) }; }

async function bucketCheck(s3, config, bucket) {
  const input = { Bucket: bucket, ...owner(config) };
  const [versioning, lock] = await Promise.all([
    s3.send(new GetBucketVersioningCommand(input)),
    s3.send(new GetObjectLockConfigurationCommand(input))]);
  return versioning.Status === 'Enabled' && lock.ObjectLockConfiguration?.ObjectLockEnabled === 'Enabled';
}

async function assertWriteDestination(config, clients) {
  const identity = await clients.sts.send(new GetCallerIdentityCommand({}));
  if (identity.Account !== config.expectedAccount ||
      identity.Arn !== config.expectedPrincipal)
    throw new Error('external_identity_mismatch');
  if (!await bucketCheck(clients.s3, config, config.bucket) ||
      !await bucketCheck(clients.s3, config, config.anchorBucket))
    throw new Error('external_bucket_capability_missing');
}

async function versions(s3, config, bucket, key) {
  const found = [];
  let KeyMarker; let VersionIdMarker;
  do {
    const page = await s3.send(new ListObjectVersionsCommand({ Bucket: bucket,
      Prefix: key, MaxKeys: 100, KeyMarker, VersionIdMarker, ...owner(config) }));
    found.push(...(page.Versions ?? []).filter(item => item.Key === key));
    if ((page.DeleteMarkers ?? []).some(item => item.Key === key))
      throw new Error('external_delete_marker_present');
    if (!page.IsTruncated) break;
    if (!page.NextKeyMarker ||
        (page.NextKeyMarker === KeyMarker && page.NextVersionIdMarker === VersionIdMarker))
      throw new Error('external_versions_incomplete');
    KeyMarker = page.NextKeyMarker; VersionIdMarker = page.NextVersionIdMarker;
  } while (true);
  return found;
}

async function retainedVersion(s3, config, bucket, key, versionId) {
  if (!versionId || versionId === 'null') throw new Error('external_version_missing');
  const list = await versions(s3, config, bucket, key);
  if (list.length !== 1 || list[0]?.VersionId !== versionId)
    throw new Error('external_version_unexpected');
  const response = await s3.send(new GetObjectRetentionCommand({ Bucket: bucket,
    Key: key, VersionId: versionId, ...owner(config) }));
  if (response.Retention?.Mode !== 'COMPLIANCE' ||
      !response.Retention.RetainUntilDate ||
      new Date(response.Retention.RetainUntilDate).getTime() < Date.parse(config.retainUntil))
    throw new Error('external_retention_insufficient');
}

async function contentHash(s3, config, bucket, key, versionId, maxBytes = Infinity) {
  const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key,
    VersionId: versionId, ...owner(config) }));
  if (response.VersionId !== versionId || !response.Body)
    throw new Error('external_read_version_mismatch');
  const hash = createHash('sha256'); let bytes = 0;
  for await (const chunk of response.Body) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw new Error('external_object_too_large');
    hash.update(chunk);
  }
  return { sha256: hash.digest('hex'), bytes };
}

export async function verifyReceipt(config, clients, receipt) {
  const bucket = receipt.kind === 'anchor' ? config.anchorBucket : config.bucket;
  const key = safeKey(config, receipt.kind, receipt.id);
  if (receipt.bucket !== bucket || receipt.key !== key || !hex.test(receipt.sha256 ?? ''))
    throw new Error('external_receipt_invalid');
  await retainedVersion(clients.s3, config, bucket, key, receipt.versionId);
  const read = await contentHash(clients.s3, config, bucket, key, receipt.versionId);
  if (read.sha256 !== receipt.sha256 || read.bytes !== receipt.bytes)
    throw new Error('external_checksum_mismatch');
  return true;
}

export async function putProtected(config, clients, kind, id, body, expectedSha) {
  const bucket = kind === 'anchor' ? config.anchorBucket : config.bucket;
  const key = safeKey(config, kind, id);
  const bytes = Buffer.isBuffer(body) ? body.length : statSync(body).size;
  const digest = expectedSha ?? (Buffer.isBuffer(body) ? sha(body) : await fileHash(body));
  if (!hex.test(digest) || bytes < 1) throw new Error('external_payload_invalid');
  const response = await clients.s3.send(new PutObjectCommand({ Bucket: bucket, Key: key,
    Body: Buffer.isBuffer(body) ? body : createReadStream(body), ContentLength: bytes,
    ChecksumSHA256: Buffer.from(digest, 'hex').toString('base64'),
    ObjectLockMode: 'COMPLIANCE', ObjectLockRetainUntilDate: new Date(config.retainUntil),
    IfNoneMatch: '*', ...owner(config) }));
  if (!response.VersionId || response.VersionId === 'null')
    throw new Error('external_version_missing');
  const receipt = { kind, id, bucket, key, versionId: response.VersionId,
    sha256: digest, bytes, retainUntil: config.retainUntil };
  await verifyReceipt(config, clients, receipt);
  return receipt;
}

async function putOrVerify(config, clients, kind, id, body, digest) {
  const bucket = kind === 'anchor' ? config.anchorBucket : config.bucket;
  const key = safeKey(config, kind, id);
  const existing = await versions(clients.s3, config, bucket, key);
  if (!existing.length) return putProtected(config, clients, kind, id, body, digest);
  if (existing.length !== 1) throw new Error('external_version_unexpected');
  const receipt = { kind, id, bucket, key, versionId:existing[0].VersionId,
    sha256:digest, bytes:Buffer.isBuffer(body) ? body.length : statSync(body).size,
    retainUntil:config.retainUntil };
  await verifyReceipt(config, clients, receipt);
  return receipt;
}

async function fileHash(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function listAll(s3, config, bucket, prefix) {
  const items = []; let KeyMarker; let VersionIdMarker;
  do {
    const page = await s3.send(new ListObjectVersionsCommand({ Bucket: bucket,
      Prefix: prefix, MaxKeys: 100, KeyMarker, VersionIdMarker, ...owner(config) }));
    items.push(...(page.Versions ?? []).filter(item => item.Key?.startsWith(prefix)));
    if ((page.DeleteMarkers ?? []).some(item => item.Key?.startsWith(prefix)))
      throw new Error('external_delete_marker_present');
    if (!page.IsTruncated) return items;
    if (!page.NextKeyMarker ||
        (page.NextKeyMarker === KeyMarker && page.NextVersionIdMarker === VersionIdMarker))
      throw new Error('external_versions_incomplete');
    KeyMarker = page.NextKeyMarker; VersionIdMarker = page.NextVersionIdMarker;
  } while (true);
}

/** Read-only. IAM effective policy, encryption key access and durability need operator review. */
async function smallObject(s3, config, bucket, key, versionId) {
  const response = await s3.send(new GetObjectCommand({ Bucket:bucket, Key:key,
    VersionId:versionId, ...owner(config) }));
  if (response.VersionId !== versionId || !response.Body)
    throw new Error('external_read_version_mismatch');
  const parts = []; let total = 0;
  for await (const part of response.Body) {
    total += part.length;
    if (total > 64 * 1024) throw new Error('external_object_too_large');
    parts.push(part);
  }
  return Buffer.concat(parts);
}

export async function preflight(config, clients, expectedSequence, expectedAnchorSha, journalKey) {
  const checks = [];
  try {
    const identity = await clients.sts.send(new GetCallerIdentityCommand({}));
    checks.push(result('identity', identity.Account === config.expectedAccount &&
      identity.Arn === config.expectedPrincipal, 'unexpected_principal'));
  } catch { checks.push(result('identity', false, 'identity_unavailable')); }
  for (const [name, bucket] of [['backup_bucket', config.bucket],
    ['anchor_bucket', config.anchorBucket]]) {
    try { checks.push(result(name, await bucketCheck(clients.s3, config, bucket),
      'versioning_or_object_lock_disabled')); }
    catch { checks.push(result(name, false, 'bucket_capability_unavailable')); }
  }
  try {
    if (!Number.isSafeInteger(expectedSequence) || expectedSequence < 0)
      throw new Error('external_sequence_required');
    const entries = await listAll(clients.s3, config, config.anchorBucket,
      `${config.prefix}/anchor/`);
    const sequences = entries.map(item => Number(item.Key?.split('/').at(-1)));
    if (sequences.length !== expectedSequence ||
        sequences.some((value, index) => !Number.isSafeInteger(value) || value !== index + 1))
      throw new Error('external_anchor_sequence_incomplete');
    if (expectedSequence > 0 && (!hex.test(expectedAnchorSha ?? '') ||
        !journalKey || journalKey.length < 32))
      throw new Error('external_checkpoint_required');
    let previous = '0'.repeat(64);
    let previousEventSignature = '0'.repeat(64);
    for (const item of entries) {
      await retainedVersion(clients.s3, config, config.anchorBucket,
        item.Key, item.VersionId);
      const body = await smallObject(clients.s3, config, config.anchorBucket,
        item.Key, item.VersionId);
      const parsed = JSON.parse(body.toString('utf8'));
      const anchor = parsed.anchor;
      const expectedSignature = createHmac('sha256', journalKey)
        .update(JSON.stringify(anchor)).digest('hex');
      if (anchor?.sequence !== Number(item.Key.split('/').at(-1)) ||
          anchor.previous_anchor_sha256 !== previous ||
          !hex.test(anchor.event_sha256 ?? '') ||
          parsed.signature !== expectedSignature)
        throw new Error('external_anchor_invalid');
      const eventKey = safeKey(config, 'journal', String(anchor.sequence).padStart(12, '0'));
      const eventVersions = await versions(clients.s3, config, config.bucket, eventKey);
      if (eventVersions.length !== 1) throw new Error('external_journal_version_missing');
      await retainedVersion(clients.s3, config, config.bucket, eventKey,
        eventVersions[0].VersionId);
      const event = await smallObject(clients.s3, config, config.bucket,
        eventKey, eventVersions[0].VersionId);
      if (sha(event) !== anchor.event_sha256)
        throw new Error('external_journal_checksum_mismatch');
      const signedEvent = JSON.parse(event.toString('utf8'));
      const expectedEventSignature = createHmac('sha256', journalKey)
        .update(JSON.stringify(signedEvent.event)).digest('hex');
      if (signedEvent.event?.sequence !== anchor.sequence ||
          signedEvent.event?.previous_signature !== previousEventSignature ||
          signedEvent.signature !== expectedEventSignature ||
          signedEvent.signature !== anchor.event_signature)
        throw new Error('external_journal_signature_invalid');
      previousEventSignature = signedEvent.signature;
      previous = sha(body);
    }
    if (expectedSequence > 0 && previous !== expectedAnchorSha)
      throw new Error('external_checkpoint_mismatch');
    checks.push(result('anchor_continuity', true));
  } catch (error) { checks.push(result('anchor_continuity', false,
    error instanceof Error && /^external_[a-z_]+$/.test(error.message)
      ? error.message : 'anchor_unavailable')); }
  checks.push({ name:'least_privilege_policy', status:'pending',
    reason:'effective_iam_and_bucket_policy_review_required' });
  checks.push({ name:'real_restore_release', status:'pending',
    reason:'independent_infrastructure_and_restore_audit_not_verified' });
  return { status:'blocked', checks };
}

/** Publish an already signed local journal, then a separate immutable anchor for each event. */
export async function publishJournal(config, clients, directory, key, readJournal) {
  await assertWriteDestination(config, clients);
  const events = readJournal(directory, key);
  let previous = '0'.repeat(64);
  let anchorVersionId = null;
  for (const event of events) {
    const id = String(event.sequence).padStart(12, '0');
    const eventName = `${id}-${event.kind}-${event.tenant_id}-${event.source_id}`
      + (event.document_id ? `-${event.document_id}` : '') + '.json';
    const payload = readFileSync(`${directory}/${eventName}`);
    const envelope = JSON.parse(payload.toString('utf8'));
    const anchor = { version:1, sequence:event.sequence, event_sha256:sha(payload),
      previous_anchor_sha256:previous, event_signature:envelope.signature };
    const signed = Buffer.from(JSON.stringify({ anchor,
      signature:createHmac('sha256', key).update(JSON.stringify(anchor)).digest('hex') }));
    const anchorSha = sha(signed);
    for (const [kind, value, digest] of [
      ['journal',payload,anchor.event_sha256],
      ['anchor',signed,anchorSha]]) {
      const receipt = await putOrVerify(config, clients, kind, id, value, digest);
      if (kind === 'anchor') anchorVersionId = receipt.versionId;
    }
    previous = anchorSha;
  }
  return { sequence:events.length, anchor_sha256:previous,
    anchor_version_id:anchorVersionId };
}

export async function publishBackup(config, clients, archive, signatureKey,
  expectedSequence, expectedAnchorSha) {
  await assertWriteDestination(config, clients);
  const envelope = JSON.parse(readFileSync(`${archive}.manifest.json`, 'utf8'));
  const manifest = envelope.manifest;
  if (!manifest || manifest.version !== 1 || !hex.test(manifest.sha256 ?? '') ||
      !hex.test(envelope.signature ?? '') || !signatureKey || signatureKey.length < 32)
    throw new Error('external_manifest_invalid');
  const expected = createHmac('sha256', signatureKey)
    .update(JSON.stringify(manifest)).digest('hex');
  if (!timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(envelope.signature, 'hex')) ||
      statSync(archive).size !== manifest.bytes || await fileHash(archive) !== manifest.sha256)
    throw new Error('external_manifest_invalid');
  if (manifest.journal_baseline !== expectedSequence)
    throw new Error('external_journal_baseline_mismatch');
  const continuity = await preflight(config, clients, expectedSequence,
    expectedAnchorSha, signatureKey);
  if (continuity.checks.some(check => check.status === 'failed'))
    throw new Error('external_journal_continuity_failed');
  // Content-addressed keys prevent a reused local filename replacing an older backup.
  const id = manifest.sha256;
  const backup = await putOrVerify(config, clients, 'backup', id, archive, manifest.sha256);
  const manifestBytes = readFileSync(`${archive}.manifest.json`);
  const receipt = await putOrVerify(config, clients, 'manifest', sha(manifestBytes),
    manifestBytes, sha(manifestBytes));
  return { backup, manifest:receipt };
}
