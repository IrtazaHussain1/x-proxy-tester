/**
 * Data Archival Service
 * 
 * Archives old proxy request data to manage database size.
 * Implements data retention policies and archival strategies.
 * 
 * @module services/archival
 */

import { prismaWithRetry as prisma } from '../lib/db';
import { logger } from '../lib/logger';

/**
 * Default retention periods (in days)
 */
const DEFAULT_RETENTION_DAYS = parseInt(process.env.DATA_RETENTION_DAYS || '30', 10);
const ARCHIVAL_BATCH_SIZE = parseInt(process.env.ARCHIVAL_BATCH_SIZE || '1000', 10);

/**
 * Archive old proxy requests
 * 
 * @param retentionDays - Number of days to retain (default: 30)
 * @returns Number of records archived
 */
export async function archiveOldRequests(retentionDays: number = DEFAULT_RETENTION_DAYS): Promise<number> {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - retentionDays);

  logger.info(
    {
      retentionDays,
      cutoffDate: cutoffDate.toISOString(),
    },
    'Starting data archival'
  );

  let totalArchived = 0;
  let hasMore = true;

  while (hasMore) {
    try {
      // Delete in batches to avoid long-running transactions
      // First, find IDs to delete
      const idsToDelete = await prisma.proxyRequest.findMany({
        where: {
          timestamp: {
            lt: cutoffDate,
          },
        },
        select: {
          id: true,
        },
        take: ARCHIVAL_BATCH_SIZE,
      });

      if (idsToDelete.length === 0) {
        hasMore = false;
        break;
      }

      // Delete the found records
      const result = await prisma.proxyRequest.deleteMany({
        where: {
          id: {
            in: idsToDelete.map((r) => r.id),
          },
        },
      });

      totalArchived += result.count;
      hasMore = idsToDelete.length === ARCHIVAL_BATCH_SIZE;

      if (result.count > 0) {
        logger.debug(
          {
            archived: result.count,
            totalArchived,
            hasMore,
          },
          'Archived batch of old requests'
        );
      }

      // Small delay between batches to avoid overwhelming the database
      if (hasMore) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    } catch (error) {
      logger.error(
        {
          error: error instanceof Error ? error.message : 'Unknown error',
          totalArchived,
        },
        'Error during archival batch'
      );
      throw error;
    }
  }

  logger.info(
    {
      totalArchived,
      retentionDays,
      cutoffDate: cutoffDate.toISOString(),
    },
    'Data archival completed'
  );

  return totalArchived;
}

/**
 * Get archival statistics
 */
export async function getArchivalStats(): Promise<{
  totalRequests: number;
  requestsOlderThan30Days: number;
  requestsOlderThan90Days: number;
  oldestRequest: Date | null;
}> {
  const now = new Date();
  const thirtyDaysAgo = new Date(now);
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const ninetyDaysAgo = new Date(now);
  ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);

  const [totalRequests, requestsOlderThan30Days, requestsOlderThan90Days, oldestRequest] =
    await Promise.all([
      prisma.proxyRequest.count(),
      prisma.proxyRequest.count({
        where: {
          timestamp: {
            lt: thirtyDaysAgo,
          },
        },
      }),
      prisma.proxyRequest.count({
        where: {
          timestamp: {
            lt: ninetyDaysAgo,
          },
        },
      }),
      prisma.proxyRequest.findFirst({
        orderBy: {
          timestamp: 'asc',
        },
        select: {
          timestamp: true,
        },
      }),
    ]);

  return {
    totalRequests,
    requestsOlderThan30Days,
    requestsOlderThan90Days,
    oldestRequest: oldestRequest?.timestamp || null,
  };
}

/**
 * Start periodic archival
 * 
 * @param intervalMs - Interval between archival runs (default: 24 hours)
 * @param retentionDays - Number of days to retain (default: 30)
 * @returns Interval ID for clearing
 */
export function startPeriodicArchival(
  intervalMs: number = 24 * 60 * 60 * 1000, // 24 hours
  retentionDays: number = DEFAULT_RETENTION_DAYS
): NodeJS.Timeout {
  logger.info(
    {
      intervalMs,
      retentionDays,
      intervalHours: intervalMs / (60 * 60 * 1000),
    },
    'Starting periodic data archival'
  );

  // Run immediately
  void archiveOldRequests(retentionDays).catch((error) => {
    logger.error({ error }, 'Periodic archival failed');
  });

  // Then run periodically
  const interval = setInterval(() => {
    void archiveOldRequests(retentionDays).catch((error) => {
      logger.error({ error }, 'Periodic archival failed');
    });
  }, intervalMs);

  return interval;
}

