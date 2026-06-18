import { Queue, Worker, JobsOptions } from 'bullmq';
import IORedis, { RedisOptions } from 'ioredis';
import { logger } from './logger';
import type { Device, ProxyMetrics, RequestSource } from '../types';

const QUEUE_NAME = 'proxy-test-write';

export interface ProxyTestWriteJobData {
  device: Device;
  metrics: ProxyMetrics;
  source: RequestSource;
}

let queue: Queue<ProxyTestWriteJobData> | null = null;
let worker: Worker<ProxyTestWriteJobData> | null = null;
let connection: IORedis | null = null;

function shouldPurgeCompletedJobs(): boolean {
  return process.env.BULLMQ_PURGE_COMPLETED_JOBS !== 'false';
}

function getFailedJobRetentionCount(): number {
  const value = parseInt(process.env.BULLMQ_KEEP_FAILED_JOBS || '2000', 10);
  if (isNaN(value) || value < 0) {
    return 2000;
  }
  return value;
}

function getRedisConfig(): RedisOptions {
  const host = process.env.REDIS_HOST || '127.0.0.1';
  const port = parseInt(process.env.REDIS_PORT || '6379', 10);
  const password = process.env.REDIS_PASSWORD || undefined;
  const db = parseInt(process.env.REDIS_DB || '0', 10);

  return {
    host,
    port,
    password,
    db,
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  };
}

function getQueueConnection(): IORedis {
  if (!connection) {
    connection = new IORedis(getRedisConfig());
  }
  return connection;
}

function getOrCreateQueue(): Queue<ProxyTestWriteJobData> {
  if (!queue) {
    queue = new Queue<ProxyTestWriteJobData>(QUEUE_NAME, {
      connection: getQueueConnection(),
      defaultJobOptions: {
        removeOnComplete: shouldPurgeCompletedJobs() ? true : 2000,
        removeOnFail: getFailedJobRetentionCount(),
        attempts: 5,
        backoff: {
          type: 'exponential',
          delay: 1000,
        },
      },
    });
  }
  return queue;
}

export async function enqueueProxyTestWriteJob(data: ProxyTestWriteJobData): Promise<void> {
  const q = getOrCreateQueue();
  const options: JobsOptions = {
    // BullMQ custom ids cannot contain ":".
    jobId: `${data.device.device_id}-${data.source}-${Date.now()}`,
  };
  await q.add('write', data, options);
}

export function startProxyTestWriteWorker(
  handler: (data: ProxyTestWriteJobData) => Promise<void>
): void {
  if (worker) {
    return;
  }

  const concurrency = parseInt(process.env.PROXY_TEST_WRITE_WORKER_CONCURRENCY || '5', 10);

  worker = new Worker<ProxyTestWriteJobData>(
    QUEUE_NAME,
    async (job) => {
      await handler(job.data);
    },
    {
      connection: getQueueConnection(),
      concurrency,
    }
  );

  worker.on('failed', (job, error) => {
    logger.error(
      {
        jobId: job?.id,
        queue: QUEUE_NAME,
        error: error instanceof Error ? error.message : String(error),
      },
      'Proxy test write job failed'
    );
  });

  worker.on('error', (error) => {
    logger.error(
      { queue: QUEUE_NAME, error: error instanceof Error ? error.message : String(error) },
      'Proxy test write worker error'
    );
  });

  logger.info({ queue: QUEUE_NAME, concurrency }, 'Proxy test write worker started');
}

export async function stopProxyTestWriteQueue(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
  if (queue) {
    await queue.close();
    queue = null;
  }
  if (connection) {
    await connection.quit();
    connection = null;
  }
}
