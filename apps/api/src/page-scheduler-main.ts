import 'reflect-metadata';
import { Db } from './db';
import { Jobs } from './queue';
import { PageScheduler } from './page-scheduler';
import { SignalScheduler } from './signal-scheduler';
import { GitHubScheduler } from './github-scheduler';
import { B2BRightsLifecycle } from './b2b-rights-lifecycle';
import { schedulerErrorLabel } from './scheduler-error';

if (!process.env.PROVISION_DATABASE_URL || !process.env.REDIS_URL) {
  throw new Error('PROVISION_DATABASE_URL and REDIS_URL are required');
}
async function main(): Promise<void> {
  const db = new Db();
  const jobs = new Jobs();
  const scheduler = new PageScheduler(db, jobs);
  const github = new GitHubScheduler(db, jobs);
  const signals = new SignalScheduler(db, jobs);
  const b2bRights = new B2BRightsLifecycle(db);
  signals.startWorker();
  console.info('MarketRift scheduler started');
  const testPoll = process.env.MARKETRIFT_TEST_MODE === '1' ? Number(process.env.PAGE_SCHEDULER_TEST_POLL_MS) : NaN;
  const pollMs = Number.isFinite(testPoll) && testPoll >= 100 ? testPoll : 15_000;
  let stopping = false;
  let wake: (() => void) | undefined;
  const stop = (): void => { stopping = true; wake?.(); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    while (!stopping) {
      try { await b2bRights.tick(); }
      catch (error) { console.warn('B2B rights lifecycle tick failed:', schedulerErrorLabel(error)); }
      try { await scheduler.tick(); }
      catch (error) { console.warn('Page scheduler tick failed:', schedulerErrorLabel(error)); }
      try { await github.tick(); }
      catch (error) { console.warn('GitHub scheduler tick failed:', schedulerErrorLabel(error)); }
      try { await signals.tick(); }
      catch (error) { console.warn('Signal scheduler tick failed:', schedulerErrorLabel(error)); }
      if (!stopping) await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, pollMs);
        wake = () => { clearTimeout(timer); resolve(); };
      });
    }
  } finally { await signals.close(); await Promise.all([jobs.onModuleDestroy(), db.onModuleDestroy()]); }
}
void main();
