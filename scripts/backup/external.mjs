/** Explicit operational entry point. No network call when backend is disabled. */
import { readFileSync } from 'node:fs';
import { externalConfig, awsClients, preflight, publishBackup,
  publishJournal, verifyReceipt } from './s3-object-lock.mjs';

const command = process.argv[2];
const config = externalConfig();
if (!config) {
  console.log(JSON.stringify({ status:'blocked', reason:'external_backend_disabled' }));
  process.exitCode = 2;
} else {
  const clients = awsClients(config);
  try {
    let result;
    if (command === 'preflight') {
      result = await preflight(config, clients, Number(process.env.BACKUP_S3_EXPECTED_SEQUENCE),
        process.env.BACKUP_S3_EXPECTED_ANCHOR_SHA256,
        process.env.BACKUP_DELETION_JOURNAL_KEY);
    } else if (command === 'verify-receipt') {
      const receipt = JSON.parse(readFileSync(process.env.BACKUP_S3_RECEIPT_PATH, 'utf8'));
      await verifyReceipt(config, clients, receipt);
      result = { status:'verified', kind:receipt.kind, versionId:receipt.versionId };
    } else if (command === 'publish-backup' && process.env.BACKUP_S3_ALLOW_UPLOAD === '1') {
      const archive = process.env.BACKUP_ARCHIVE_PATH;
      if (!archive) throw new Error('external_archive_required');
      result = await publishBackup(config, clients, archive,
        process.env.BACKUP_DELETION_JOURNAL_KEY,
        Number(process.env.BACKUP_S3_EXPECTED_SEQUENCE),
        process.env.BACKUP_S3_EXPECTED_ANCHOR_SHA256);
    } else if (command === 'publish-journal' && process.env.BACKUP_S3_ALLOW_UPLOAD === '1') {
      const { readDeletionJournal } = await import('../../apps/api/dist/deletion-journal.js');
      if (!process.env.BACKUP_DELETION_JOURNAL_DIR ||
          !process.env.BACKUP_DELETION_JOURNAL_KEY)
        throw new Error('external_journal_required');
      result = await publishJournal(config, clients,
        process.env.BACKUP_DELETION_JOURNAL_DIR,
        process.env.BACKUP_DELETION_JOURNAL_KEY, readDeletionJournal);
    } else throw new Error('external_command_disabled_or_invalid');
    console.log(JSON.stringify(result));
    if (result.status === 'blocked') process.exitCode = 2;
  } catch (error) {
    // SDK exceptions can include request metadata; never print their messages.
    const code = error instanceof Error && /^external_[a-z_]+$/.test(error.message)
      ? error.message : 'external_operation_failed';
    console.error(JSON.stringify({ status:'failed', reason:code }));
    process.exitCode = 1;
  } finally {
    clients.s3.destroy(); clients.sts.destroy();
  }
}
