/**
 * Data Archival Service
 * 
 * Archives old proxy request data to manage database size.
 * Implements data retention policies and archival strategies.
 * 
 * Strategy:
 * 1. Aggregate data older than 2 weeks into daily summaries
 * 2. Delete raw data older than 2 weeks (keeping only aggregated data)
 * 3. Keep daily summaries indefinitely for long-term analytics
 * 
 * @module services/archival
 */

import { prismaWithRetry as prisma } from '../lib/db';
import { logger } from '../lib/logger';
import { aggregateDailySummary } from './daily-aggregation';

/**
 * Default retention periods (in days)
 * Raw data: 14 days (2 weeks) - after which it's aggregated and deleted
 * Daily summaries: Kept indefinitely for long-term analytics
 */
const DEFAULT_RETENTION_DAYS = parseInt(process.env.DATA_RETENTION_DAYS || '14', 10);
const ARCHIVAL_BATCH_SIZE = parseInt(process.env.ARCHIVAL_BATCH_SIZE || '1000', 10);

/**
 * Archive old proxy requests
 * 
 * Process:
 * 1. First, aggregate any days older than retention period that haven't been aggregated yet
 * 2. Then, delete raw data older than retention period (aggregated data is kept)
 * 
 * @param retentionDays - Number of days to retain raw data (default: 14)
 * @returns Number of records archived (deleted)
 */
export async function archiveOldRequests(retentionDays: number = DEFAULT_RETENTION_DAYS): Promise<number> {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - retentionDays);
  cutoffDate.setHours(0, 0, 0, 0); // Start of day

  logger.info(
    {
      retentionDays,
      cutoffDate: cutoffDate.toISOString(),
    },
    'Starting data archival (aggregate then delete)'
  );

  // Step 1: Aggregate any days older than cutoff that haven't been aggregated yet
  logger.info('Step 1: Aggregating unaggregated days older than retention period');
  
  // Find days that need aggregation (older than cutoff, have data, but no daily summary)
  const daysToAggregate = await prisma.$queryRawUnsafe(
    `SELECT DISTINCT DATE(timestamp) as day
     FROM proxy_requests
     WHERE DATE(timestamp) < DATE(?)
       AND DATE(timestamp) NOT IN (
         SELECT DISTINCT day FROM proxy_requests_daily_summary
       )
     ORDER BY day ASC
     LIMIT 30`,
    cutoffDate.toISOString().split('T')[0]
  ) as Array<{ day: Date }>;

  if (daysToAggregate.length > 0) {
    logger.info(
      { daysToAggregate: daysToAggregate.length },
      'Found days that need aggregation before archival'
    );

    for (const row of daysToAggregate) {
      const day = new Date(row.day);
      try {
        await aggregateDailySummary(day);
        logger.debug({ day: day.toISOString().split('T')[0] }, 'Aggregated day before archival');
        // Small delay between aggregations
        await new Promise((resolve) => setTimeout(resolve, 200));
      } catch (error) {
        logger.error(
          { error: error instanceof Error ? error.message : 'Unknown error', day: day.toISOString() },
          'Failed to aggregate day before archival'
        );
        // Continue with other days even if one fails
      }
    }
  } else {
    logger.info('All days older than retention period are already aggregated');
  }

  // Step 2: Delete raw data older than cutoff (aggregated data remains)
  logger.info('Step 2: Deleting raw data older than retention period');
  
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
      daysAggregated: daysToAggregate.length,
    },
    'Data archival completed (raw data deleted, daily summaries kept)'
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

