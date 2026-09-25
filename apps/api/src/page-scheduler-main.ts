import 'reflect-metadata';
import { Db } from './db';
import { Jobs } from './queue';
import { PageScheduler } from './page-scheduler';

if (!process.env.PROVISION_DATABASE_URL || !process.env.REDIS_URL) {
  throw new Error('PROVISION_DATABASE_URL and REDIS_URL are required');
}
async function main(): Promise<void> {
  const db = new Db();
  const jobs = new Jobs();
  const scheduler = new PageScheduler(db, jobs);
  const testPoll = process.env.MARKETRIFT_TEST_MODE === '1' ? Number(process.env.PAGE_SCHEDULER_TEST_POLL_MS) : NaN;
  const pollMs = Number.isFinite(testPoll) && testPoll >= 100 ? testPoll : 15_000;
  let stopping = false;
  let wake: (() => void) | undefined;
  const stop = (): void => { stopping = true; wake?.(); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    while (!stopping) {
      try { await scheduler.tick(); }
      catch (error) { console.warn('Page scheduler tick failed:', error instanceof Error ? error.name : 'unknown'); }
      if (!stopping) await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, pollMs);
        wake = () => { clearTimeout(timer); resolve(); };
      });
    }
  } finally { await Promise.all([jobs.onModuleDestroy(), db.onModuleDestroy()]); }
}
void main();
