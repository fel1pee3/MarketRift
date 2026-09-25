import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import { IngestReviewJobV1 } from './job';
import { AnalyzeDocumentJobV1 } from './analysis-job';
import { SyncGitHubIssuesJobV1 } from './github-job';
import { SyncSteamReviewsJobV1 } from './steam-job';
import { CheckWebPageJobV1 } from './web-page-job';

@Injectable()
export class Jobs implements OnModuleDestroy {
  private readonly redisUrl = new URL(process.env.REDIS_URL ?? 'redis://localhost:6380');
  private readonly connection = {
    host: this.redisUrl.hostname,
    port: Number(this.redisUrl.port || 6379),
    username: decodeURIComponent(this.redisUrl.username || 'default'),
    password: this.redisUrl.password ? decodeURIComponent(this.redisUrl.password) : undefined,
    db: Number(this.redisUrl.pathname.slice(1) || 0),
    tls: this.redisUrl.protocol === 'rediss:' ? {} : undefined,
    maxRetriesPerRequest: 1,
  };
  private readonly queue = new Queue<IngestReviewJobV1>('review-ingest', {
    connection: this.connection,
  });
  private readonly analysisQueue = new Queue<AnalyzeDocumentJobV1>('review-analysis', {
    connection: this.connection,
  });
  private readonly githubQueue = new Queue<SyncGitHubIssuesJobV1>('github-issues', {
    connection: this.connection,
  });
  private readonly steamQueue = new Queue<SyncSteamReviewsJobV1>('steam-reviews', {
    connection: this.connection,
  });
  private readonly webPageQueue = new Queue<CheckWebPageJobV1>('web-pages', {
    connection: this.connection,
  });

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

  async publishAnalysis(job: AnalyzeDocumentJobV1): Promise<void> {
    await this.analysisQueue.add('analyze-document.v1', job, {
      jobId: job.idempotency_key,
      attempts: 3,
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

  async publishSteam(job: SyncSteamReviewsJobV1): Promise<void> {
    await this.steamQueue.add('sync-steam-reviews.v1', job, {
      jobId: job.idempotency_key, attempts: 1,
      removeOnComplete: true, removeOnFail: true,
    });
  }

  async publishWebPage(job: CheckWebPageJobV1): Promise<void> {
    await this.webPageQueue.add('check-web-page.v1', job, {
      jobId: job.idempotency_key, attempts: 1, removeOnComplete: true, removeOnFail: true,
    });
  }

  async onModuleDestroy(): Promise<void> { await Promise.all([this.queue.close(), this.analysisQueue.close(), this.githubQueue.close(), this.steamQueue.close(), this.webPageQueue.close()]); }
}
