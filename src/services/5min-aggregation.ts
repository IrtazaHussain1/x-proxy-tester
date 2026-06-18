/**
 * 5-Minute Aggregation Service
 *
 * Populates `proxy_requests_5min_summary` every 5 minutes by running a single
 * INSERT … SELECT … ON DUPLICATE KEY UPDATE against the partitioned
 * `proxy_requests` table. The SELECT uses a grouped subquery plus a window-function
 * join for `last_outbound_ip` (not a correlated subquery per proxy) to minimize
 * lock time and contention with continuous `proxy_requests` inserts.
 *
 * The summary is the primary read tier for:
 *   - Grafana live dashboards (1h – 48h time ranges)
 *   - The stability calculator (replaces its 24h raw scan)
 *   - The analytics problems API (replaces its 1h raw scan)
 *
 * Window alignment: FLOOR(UNIX_TIMESTAMP(timestamp) / 300) * 300
 *   → values like 14:00:00, 14:05:00, 14:10:00 …
 *
 * Each tick re-aggregates TWO windows:
 *   1. The previous complete 5-min window (handles rows that arrived late within
 *      the batch-writer's 2-second flush interval).
 *   2. The current incomplete window (so the table is never more than 5 min stale).
 *
 * Retention: 2 days.  A separate hourly purge job deletes stale rows.
 *
 * @module services/5min-aggregation
 */

import { Prisma } from '@prisma/client';
import { logger } from '../lib/logger';
import { backgroundDb, hasDatabaseCapacityForBackgroundJobs, retryWithBackoff } from '../lib/db';
import { registerIntervalJob, stopScheduledJob } from './cron.service';

let isRunning = false;

// ---------------------------------------------------------------------------
// Window helpers
// ---------------------------------------------------------------------------

/** Returns the UTC floor of the 5-minute window containing `date`. */
function floorTo5Min(date: Date): Date {
  const ms = date.getTime();
  return new Date(Math.floor(ms / 300_000) * 300_000);
}

// ---------------------------------------------------------------------------
// Core aggregation
// ---------------------------------------------------------------------------

/**
 * Aggregates proxy_requests rows in [windowStart, windowStart + 5min) into
 * a single upsert row per proxy in proxy_requests_5min_summary.
 *
 * Uses one grouped scan plus a window-function pass for last_outbound_ip instead of a
 * correlated subquery per proxy_id. The old shape executed O(proxies) secondary index
 * lookups and held locks far longer, starving continuous `proxy_requests` batch inserts.
 */
async function aggregateWindow(windowStart: Date): Promise<number> {
  const windowEnd = new Date(windowStart.getTime() + 300_000);

  const insertSql = `INSERT INTO proxy_requests_5min_summary
       (window_start, proxy_id,
        total_requests, success_count, failure_count,
        timeout_count, connection_error_count, http_error_count, dns_error_count,
        ip_change_count, slow_request_count,
        success_rate_pct,
        avg_response_time_ms, min_response_time_ms, max_response_time_ms,
        last_outbound_ip,
        updated_at)
     SELECT
       ? AS window_start,
       a.proxy_id,
       a.total_requests,
       a.success_count,
       a.failure_count,
       a.timeout_count,
       a.connection_error_count,
       a.http_error_count,
       a.dns_error_count,
       a.ip_change_count,
       a.slow_request_count,
       a.success_rate_pct,
       a.avg_response_time_ms,
       a.min_response_time_ms,
       a.max_response_time_ms,
       li.outbound_ip AS last_outbound_ip,
       NOW()
     FROM (
       SELECT
         proxy_id,
         COUNT(*)                                                          AS total_requests,
         SUM(status = 'SUCCESS')                                           AS success_count,
         SUM(status != 'SUCCESS')                                          AS failure_count,
         SUM(status = 'TIMEOUT')                                           AS timeout_count,
         SUM(status = 'CONNECTION_ERROR')                                   AS connection_error_count,
         SUM(status = 'HTTP_ERROR')                                        AS http_error_count,
         SUM(status = 'DNS_ERROR')                                         AS dns_error_count,
         SUM(ip_changed = 1)                                               AS ip_change_count,
         SUM(response_time_ms > 2000)                                      AS slow_request_count,
         ROUND(SUM(status = 'SUCCESS') * 100.0 / NULLIF(COUNT(*), 0), 2)  AS success_rate_pct,
         ROUND(AVG(response_time_ms), 2)                                   AS avg_response_time_ms,
         MIN(response_time_ms)                                             AS min_response_time_ms,
         MAX(response_time_ms)                                             AS max_response_time_ms
       FROM proxy_requests
       WHERE \`timestamp\` >= ? AND \`timestamp\` < ?
       GROUP BY proxy_id
     ) AS a
     LEFT JOIN (
       SELECT proxy_id, outbound_ip
       FROM (
         SELECT
           proxy_id,
           outbound_ip,
           ROW_NUMBER() OVER (PARTITION BY proxy_id ORDER BY \`timestamp\` DESC) AS rn
         FROM proxy_requests
         WHERE \`timestamp\` >= ? AND \`timestamp\` < ?
           AND outbound_ip IS NOT NULL
       ) ranked
       WHERE ranked.rn = 1
     ) AS li ON li.proxy_id = a.proxy_id
     ON DUPLICATE KEY UPDATE
       total_requests         = VALUES(total_requests),
       success_count          = VALUES(success_count),
       failure_count          = VALUES(failure_count),
       timeout_count          = VALUES(timeout_count),
       connection_error_count = VALUES(connection_error_count),
       http_error_count       = VALUES(http_error_count),
       dns_error_count        = VALUES(dns_error_count),
       ip_change_count        = VALUES(ip_change_count),
       slow_request_count     = VALUES(slow_request_count),
       success_rate_pct       = VALUES(success_rate_pct),
       avg_response_time_ms   = VALUES(avg_response_time_ms),
       min_response_time_ms   = VALUES(min_response_time_ms),
       max_response_time_ms   = VALUES(max_response_time_ms),
       last_outbound_ip       = VALUES(last_outbound_ip),
       updated_at             = NOW()`

  return retryWithBackoff(
    async () =>
      backgroundDb.$transaction(
        async (tx) =>
          tx.$executeRawUnsafe(insertSql, windowStart, windowStart, windowEnd, windowStart, windowEnd),
        {
          maxWait: 60_000,
          timeout: 600_000,
          isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        }
      ),
    '5min_aggregate_window',
    4
  );
}

/**
 * Main tick: aggregates the previous complete window and the current incomplete
 * window to keep the table fresh and handle late-arriving rows.
 */
export async function aggregate5MinWindows(): Promise<void> {
  if (!await hasDatabaseCapacityForBackgroundJobs()) {
    logger.warn('5min aggregation skipped — database pool under pressure');
    return;
  }

  const now = new Date();
  const currentWindow = floorTo5Min(now);
  const prevWindow = new Date(currentWindow.getTime() - 300_000);

  let totalRows = 0;
  try {
    for (const window of [prevWindow, currentWindow]) {
      const rows = await aggregateWindow(window);
      totalRows += rows;
    }
    logger.debug(
      { prevWindow: prevWindow.toISOString(), currentWindow: currentWindow.toISOString(), totalRows },
      '5min aggregation completed'
    );
  } catch (error) {
    logger.error(
      { error: error instanceof Error ? error.message : 'Unknown error' },
      '5min aggregation tick failed'
    );
  }
}

// ---------------------------------------------------------------------------
// Retention purge
// ---------------------------------------------------------------------------

/** Deletes rows older than 2 days from proxy_requests_5min_summary. */
export async function purge5MinSummary(): Promise<void> {
  try {
    const deleted = await backgroundDb.$executeRawUnsafe(
      `DELETE FROM proxy_requests_5min_summary WHERE window_start < NOW() - INTERVAL 2 DAY`
    );
    if (deleted > 0) {
      logger.info({ deleted }, '5min summary purge completed');
    }
  } catch (error) {
    logger.error(
      { error: error instanceof Error ? error.message : 'Unknown error' },
      '5min summary purge failed'
    );
  }
}

// ---------------------------------------------------------------------------
// Service lifecycle
// ---------------------------------------------------------------------------

/** Starts the 5-minute aggregation service. */
export function start5MinAggregationService(): void {
  if (isRunning) {
    logger.warn('5min aggregation service is already running');
    return;
  }
  isRunning = true;

  registerIntervalJob('5min-aggregation', 5 * 60 * 1000, aggregate5MinWindows, {
    description: 'Aggregates previous and current 5-minute windows into summary rows.',
    runImmediately: true,
  });
  registerIntervalJob('5min-summary-purge', 60 * 60 * 1000, purge5MinSummary, {
    description: 'Purges expired 5-minute summary rows older than 2 days.',
  });

  logger.info('5min aggregation service started (interval=5m, purge=1h)');
}

/** Stops the 5-minute aggregation service. */
export function stop5MinAggregationService(): void {
  stopScheduledJob('5min-aggregation');
  stopScheduledJob('5min-summary-purge');
  isRunning = false;
  logger.info('5min aggregation service stopped');
}
