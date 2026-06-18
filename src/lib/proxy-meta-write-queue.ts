import { Queue, Worker } from 'bullmq'
import IORedis, { RedisOptions } from 'ioredis'
import { logger } from './logger'

const QUEUE_NAME = 'proxy-meta-write'

export interface ProxyMetaWriteJobData {
  deviceId: string
  data: Record<string, unknown>
}

let queue: Queue<ProxyMetaWriteJobData> | null = null
let worker: Worker<ProxyMetaWriteJobData> | null = null
let connection: IORedis | null = null

function shouldPurgeCompletedJobs(): boolean {
  return process.env.BULLMQ_PURGE_COMPLETED_JOBS !== 'false'
}

function getFailedJobRetentionCount(): number {
  const value = parseInt(process.env.BULLMQ_KEEP_FAILED_JOBS || '2000', 10)
  if (isNaN(value) || value < 0) {
    return 2000
  }
  return value
}

function getRedisConfig(): RedisOptions {
  const host = process.env.REDIS_HOST || '127.0.0.1'
  const port = parseInt(process.env.REDIS_PORT || '6379', 10)
  const password = process.env.REDIS_PASSWORD || undefined
  const db = parseInt(process.env.REDIS_DB || '0', 10)

  return {
    host,
    port,
    password,
    db,
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  }
}

function getQueueConnection(): IORedis {
  if (!connection) {
    connection = new IORedis(getRedisConfig())
  }
  return connection
}

function getOrCreateQueue(): Queue<ProxyMetaWriteJobData> {
  if (!queue) {
    queue = new Queue<ProxyMetaWriteJobData>(QUEUE_NAME, {
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
    })
  }
  return queue
}

/**
 * Enqueues a per-device metadata update with BullMQ native deduplication.
 *
 * BullMQ dedup via a fixed jobId: if a job with this ID is already in waiting/delayed
 * state, the add() call is a no-op (the latest data is not merged — the queued payload
 * is kept as-is). The 200ms delay provides a coalescing window so rapid successive
 * updates for the same device collapse into a single job.
 *
 * This replaces the previous getJob/getState/updateData pattern which had a non-atomic
 * race: the worker could dequeue the job between getState() and updateData(), causing
 * updateData() to run on an already-active job.
 */
export async function enqueueOrCoalesceProxyMetaWriteJob(data: ProxyMetaWriteJobData): Promise<void> {
  const q = getOrCreateQueue()
  const jobId = `proxy-meta-${data.deviceId}`
  await q.add('write', data, {
    jobId,
    delay: 200,
    removeOnComplete: shouldPurgeCompletedJobs() ? true : 2000,
    removeOnFail: getFailedJobRetentionCount(),
    attempts: 5,
    backoff: { type: 'exponential', delay: 1000 },
  })
}

export function startProxyMetaWriteWorker(
  handler: (data: ProxyMetaWriteJobData) => Promise<void>
): void {
  if (worker) {
    return
  }

  const concurrency = parseInt(process.env.PROXY_META_WRITE_WORKER_CONCURRENCY || '1', 10)

  worker = new Worker<ProxyMetaWriteJobData>(
    QUEUE_NAME,
    async (job) => {
      await handler(job.data)
    },
    {
      connection: getQueueConnection(),
      concurrency,
    }
  )

  worker.on('failed', (job, error) => {
    logger.error(
      {
        jobId: job?.id,
        queue: QUEUE_NAME,
        error: error instanceof Error ? error.message : String(error),
      },
      'Proxy meta write job failed'
    )
  })

  worker.on('error', (error) => {
    logger.error(
      { queue: QUEUE_NAME, error: error instanceof Error ? error.message : String(error) },
      'Proxy meta write worker error'
    )
  })

  logger.info({ queue: QUEUE_NAME, concurrency }, 'Proxy meta write worker started')
}

export async function stopProxyMetaWriteQueue(): Promise<void> {
  if (worker) {
    await worker.close()
    worker = null
  }
  if (queue) {
    await queue.close()
    queue = null
  }
  if (connection) {
    await connection.quit()
    connection = null
  }
}
