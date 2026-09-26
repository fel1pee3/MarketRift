import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import { IngestReviewJobV1 } from './job';
import { AnalyzeDocumentJobV1 } from './analysis-job';
import { SyncGitHubIssuesJobV1 } from './github-job';
import { SyncGitHubDiscussionsJobV1 } from './github-discussions-job';
import { SyncSteamReviewsJobV1 } from './steam-job';
import { CheckWebPageJobV1 } from './web-page-job';
import { SyncG2ReviewsJobV1 } from './g2-job';
import { ReconcileSignalsJobV1 } from './signal-job';

export function redisConnection(): { host: string; port: number; username: string;
  password: string | undefined; db: number; tls: object | undefined; maxRetriesPerRequest: number } {
  const url = new URL(process.env.REDIS_URL ?? 'redis://localhost:6380');
  return { host: url.hostname, port: Number(url.port || 6379),
    username: decodeURIComponent(url.username || 'default'),
    password: url.password ? decodeURIComponent(url.password) : undefined,
    db: Number(url.pathname.slice(1) || 0), tls: url.protocol === 'rediss:' ? {} : undefined,
    maxRetriesPerRequest: 1 };
}

@Injectable()
export class Jobs implements OnModuleDestroy {
  private readonly connection = redisConnection();
  private readonly queue = new Queue<IngestReviewJobV1>('review-ingest', {
    connection: this.connection,
  });
  private readonly analysisQueue = new Queue<AnalyzeDocumentJobV1>('review-analysis', {
    connection: this.connection,
  });
  private readonly githubQueue = new Queue<SyncGitHubIssuesJobV1>('github-issues', {
    connection: this.connection,
  });
  private readonly discussionsQueue = new Queue<SyncGitHubDiscussionsJobV1>('github-discussions', {
    connection: this.connection,
  });
  private readonly steamQueue = new Queue<SyncSteamReviewsJobV1>('steam-reviews', {
    connection: this.connection,
  });
  private readonly g2Queue = new Queue<SyncG2ReviewsJobV1>('g2-reviews', { connection: this.connection });
  private readonly webPageQueue = new Queue<CheckWebPageJobV1>('web-pages', {
    connection: this.connection,
  });
  private readonly evidenceQueue = new Queue<{ contract_version: 'index-evidence.v1'; tenant_id: string;
    source_id: string; idempotency_key: string }>('evidence-index', { connection: this.connection });
  private readonly signalQueue = new Queue<ReconcileSignalsJobV1>('signal-reconcile',
    { connection: this.connection });

  async publishSignal(job: ReconcileSignalsJobV1): Promise<void> {
    await this.signalQueue.add('reconcile-signals.v1', job, { jobId: job.idempotency_key,
      attempts: 3, backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: true, removeOnFail: true });
  }

  async publishEvidenceIndex(tenantId: string, sourceId: string, key: string): Promise<void> {
    const job = { contract_version: 'index-evidence.v1' as const, tenant_id: tenantId,
      source_id: sourceId, idempotency_key: key };
    await this.evidenceQueue.add('index-evidence.v1', job, { jobId: key, attempts: 3,
      backoff: { type: 'exponential', delay: 1000 }, removeOnComplete: true, removeOnFail: true });
  }

  async publish(job: IngestReviewJobV1): Promise<void> {
    const existing = await this.queue.getJob(job.idempotency_key);
    if (existing) {
      const state = await existing.getState();
      if (state === 'failed') { await existing.retry(); return; }
      if (state === 'completed') await existing.remove();
      else return;
    }
    await this.queue.add('ingest-review.v1', job, {
      jobId: job.idempotency_key,
      attempts: 3,
      backoff: { type: 'exponential', delay: 1000 },
      removeOnComplete: false,
    });
  }

  async publishAnalysis(job: AnalyzeDocumentJobV1, attempts = 3): Promise<void> {
    await this.analysisQueue.add('analyze-document.v1', job, {
      jobId: job.idempotency_key,
      attempts,
      backoff: { type: 'exponential', delay: 1000 },
      removeOnComplete: true,
      removeOnFail: true,
    });
  }

  async publishGitHub(job: SyncGitHubIssuesJobV1): Promise<void> {
    await this.githubQueue.add('sync-github-issues.v1', job, {
      jobId: job.idempotency_key,
      attempts: 1,
      removeOnComplete: true,
      removeOnFail: true,
    });
  }

  async publishDiscussions(job: SyncGitHubDiscussionsJobV1): Promise<void> {
    await this.discussionsQueue.add('sync-github-discussions.v1', job, {
      jobId: job.idempotency_key, attempts: 1, removeOnComplete: true, removeOnFail: true,
    });
  }

  async publishSteam(job: SyncSteamReviewsJobV1): Promise<void> {
    await this.steamQueue.add('sync-steam-reviews.v1', job, {
      jobId: job.idempotency_key, attempts: 1,
      removeOnComplete: true, removeOnFail: true,
    });
  }

  async publishG2(job: SyncG2ReviewsJobV1): Promise<void> {
    await this.g2Queue.add('sync-g2-reviews.v1', job, {
      jobId: job.idempotency_key, attempts: 1, removeOnComplete: true, removeOnFail: true,
    });
  }

  async publishWebPage(job: CheckWebPageJobV1): Promise<void> {
    await this.webPageQueue.add('check-web-page.v1', job, {
      jobId: job.idempotency_key, attempts: 1, removeOnComplete: true, removeOnFail: true,
    });
  }

  async onModuleDestroy(): Promise<void> { await Promise.all([this.queue.close(), this.analysisQueue.close(), this.githubQueue.close(), this.discussionsQueue.close(), this.steamQueue.close(), this.g2Queue.close(), this.webPageQueue.close(), this.evidenceQueue.close(), this.signalQueue.close()]); }
}
