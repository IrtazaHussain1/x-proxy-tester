import { logger } from './logger';

let exclusiveJobCount = 0;
let exclusiveJobQueue: Promise<void> = Promise.resolve();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Returns true when an exclusive DB job is running.
 */
export function isExclusiveDbJobRunning(): boolean {
  return exclusiveJobCount > 0;
}

/**
 * Waits until no exclusive DB job is active.
 */
export async function waitForExclusiveDbJobsToFinish(): Promise<void> {
  while (isExclusiveDbJobRunning()) {
    await sleep(250);
  }
}

/**
 * Queues and runs a DB-heavy job exclusively.
 * Jobs are serialized and mark a global "exclusive mode" while running.
 */
export async function runExclusiveDbJob<T>(name: string, job: () => Promise<T>): Promise<T> {
  const queued = exclusiveJobQueue.then(async () => {
    exclusiveJobCount++;
    logger.info({ name }, 'Exclusive DB job started');
    try {
      return await job();
    } finally {
      exclusiveJobCount--;
      logger.info({ name }, 'Exclusive DB job finished');
    }
  });

  exclusiveJobQueue = queued.then(() => undefined, () => undefined);
  return queued;
}
