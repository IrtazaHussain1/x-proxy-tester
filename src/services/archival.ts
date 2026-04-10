/**
 * Data Archival Service
 *
 * Handles cleanup of old data that is NOT managed by MySQL partition events.
 *
 * What this service does:
 *   - Deletes old speed_tests rows (speed_tests is not partitioned)
 *
 * What this service does NOT do (handled by MySQL EVENTs instead):
 *   - proxy_requests deletion  → manage_proxy_requests_partitions EVENT drops the
 *     entire month partition in O(1) with no row locks. Row-by-row DELETE on a
 *     partitioned table cannot use partition pruning on a non-partition-key predicate
 *     (id IN ...) and causes massive undo log growth + lock contention with writes.
 *   - Pre-deletion aggregation → daily_aggregate_summary EVENT runs at 02:30 daily.
 *     The partition management EVENT also aggregates missing days before dropping.
 *
 * @module services/archival
 */

import { backgroundDb as prisma } from '../lib/db';
import { logger } from '../lib/logger';
import { registerIntervalJob, stopScheduledJob } from './cron.service';

const DEFAULT_RETENTION_DAYS = parseInt(process.env.DATA_RETENTION_DAYS || '30', 10);
const ARCHIVAL_BATCH_SIZE = parseInt(process.env.ARCHIVAL_BATCH_SIZE || '1000', 10);

/**
 * Deletes speed_test rows older than retentionDays.
 * speed_tests is not partitioned so it needs explicit cleanup.
 */
export async function archiveOldRequests(retentionDays: number = DEFAULT_RETENTION_DAYS): Promise<number> {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - retentionDays);
  cutoffDate.setHours(0, 0, 0, 0);

  logger.info(
    { retentionDays, cutoffDate: cutoffDate.toISOString() },
    'Starting archival (speed_tests only — proxy_requests managed by partition EVENT)'
  );

  let speedTestsArchived = 0;
  let hasMore = true;

  while (hasMore) {
    try {
      const idsToDelete = await prisma.speedTest.findMany({
        where: { timestamp: { lt: cutoffDate } },
        select: { id: true },
        take: ARCHIVAL_BATCH_SIZE,
      });

      if (idsToDelete.length === 0) {
        hasMore = false;
        break;
      }

      const result = await prisma.speedTest.deleteMany({
        where: { id: { in: idsToDelete.map((r) => r.id) } },
      });

      speedTestsArchived += result.count;
      hasMore = idsToDelete.length === ARCHIVAL_BATCH_SIZE;

      if (hasMore) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.message : 'Unknown error', speedTestsArchived },
        'Error during speed_tests archival batch'
      );
      throw error;
    }
  }

  logger.info({ speedTestsArchived, retentionDays }, 'Archival completed');
  return speedTestsArchived;
}

/**
 * Get archival statistics
 */
export async function getArchivalStats(): Promise<{
  totalRequests: number;
  requestsOlderThan30Days: number;
  oldestRequest: Date | null;
}> {
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const [totalRequests, requestsOlderThan30Days, oldestRequest] = await Promise.all([
    prisma.proxyRequest.count(),
    prisma.proxyRequest.count({ where: { timestamp: { lt: thirtyDaysAgo } } }),
    prisma.proxyRequest.findFirst({
      orderBy: { timestamp: 'asc' },
      select: { timestamp: true },
    }),
  ]);

  return {
    totalRequests,
    requestsOlderThan30Days,
    oldestRequest: oldestRequest?.timestamp || null,
  };
}

/**
 * Start periodic archival (speed_tests cleanup only).
 * proxy_requests cleanup is handled by MySQL partition EVENT — do not duplicate it here.
 */
export function startPeriodicArchival(
  intervalMs: number = 24 * 60 * 60 * 1000,
  retentionDays: number = DEFAULT_RETENTION_DAYS
): void {
  logger.info(
    { intervalMs, retentionDays, intervalHours: intervalMs / (60 * 60 * 1000) },
    'Starting periodic archival (speed_tests only)'
  );

  registerIntervalJob(
    'periodic-archival',
    intervalMs,
    async () => {
      await archiveOldRequests(retentionDays);
    },
    { runImmediately: true }
  );
}

export function stopPeriodicArchival(): void {
  stopScheduledJob('periodic-archival');
}
