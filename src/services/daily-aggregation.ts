/**
 * Daily Aggregation Service
 * 
 * Aggregates proxy request data by day into summary records.
 * This service compiles complete day data into single records for long-term storage.
 * 
 * @module services/daily-aggregation
 */

import { logger } from '../lib/logger';
import { prisma } from '../lib/db';
import { checkDatabaseHealth } from '../lib/db';

let aggregationInterval: NodeJS.Timeout | null = null;
let isRunning = false;

/**
 * Aggregates data for a specific day into daily summary
 * 
 * @param day - The day to aggregate (will use DATE part only)
 * @returns Number of records aggregated (proxy count for that day)
 */
export async function aggregateDailySummary(day?: Date): Promise<number> {
  const dbHealth = await checkDatabaseHealth();
  if (!dbHealth.connected) {
    logger.error('Database not connected, skipping daily aggregation');
    return 0;
  }

  // Default to yesterday if not specified (aggregate previous day's data)
  const targetDay = day || new Date(Date.now() - 24 * 60 * 60 * 1000);
  const dayStart = new Date(targetDay);
  dayStart.setHours(0, 0, 0, 0);
  const dayDate = dayStart.toISOString().split('T')[0]; // YYYY-MM-DD format

  try {
    logger.info({ day: dayDate }, 'Starting daily aggregation');

    // Use stored procedure if available, otherwise use direct SQL
    try {
      await prisma.$executeRawUnsafe(
        `CALL aggregate_daily_summary(?)`,
        dayDate
      );
    } catch (error: any) {
      // If stored procedure doesn't exist, use direct SQL
      if (error?.message?.includes('does not exist') || error?.code === '42000') {
        logger.debug('Stored procedure not found, using direct SQL');
        
        await prisma.$executeRawUnsafe(`
          INSERT INTO proxy_requests_daily_summary (
            day,
            proxy_id,
            location,
            relay_server_id,
            relay_server_ip,
            total_requests,
            success_count,
            failure_count,
            success_rate_pct,
            avg_response_time_ms,
            min_response_time_ms,
            max_response_time_ms,
            timeout_count,
            connection_error_count,
            http_error_count,
            dns_error_count,
            rotation_count,
            avg_download_speed_mbps,
            avg_upload_speed_mbps,
            max_download_speed_mbps,
            max_upload_speed_mbps,
            min_download_speed_mbps,
            min_upload_speed_mbps,
            unique_ips_count,
            ip_diversity_score
          )
          SELECT
            dt.day,
            dt.proxy_id,
            dt.location,
            dt.relay_server_id,
            dt.relay_server_ip,
            dt.total_requests,
            dt.success_count,
            dt.failure_count,
            dt.success_rate_pct,
            dt.avg_response_time_ms,
            dt.min_response_time_ms,
            dt.max_response_time_ms,
            dt.timeout_count,
            dt.connection_error_count,
            dt.http_error_count,
            dt.dns_error_count,
            dt.rotation_count,
            dt.avg_download_speed_mbps,
            dt.avg_upload_speed_mbps,
            dt.max_download_speed_mbps,
            dt.max_upload_speed_mbps,
            dt.min_download_speed_mbps,
            dt.min_upload_speed_mbps,
            dt.unique_ips_count,
            dt.ip_diversity_score
          FROM (
            SELECT
              DATE(pr.timestamp) AS day,
              pr.proxy_id,
              p.location,
              p.relay_server_id,
              p.relay_server_ip_address AS relay_server_ip,
              COUNT(*) AS total_requests,
              COUNT(CASE WHEN pr.status = 'SUCCESS' THEN 1 END) AS success_count,
              COUNT(CASE WHEN pr.status != 'SUCCESS' THEN 1 END) AS failure_count,
              ROUND(COUNT(CASE WHEN pr.status = 'SUCCESS' THEN 1 END) / COUNT(*) * 100, 2) AS success_rate_pct,
              AVG(pr.response_time_ms) AS avg_response_time_ms,
              MIN(pr.response_time_ms) AS min_response_time_ms,
              MAX(pr.response_time_ms) AS max_response_time_ms,
              COUNT(CASE WHEN pr.status = 'TIMEOUT' THEN 1 END) AS timeout_count,
              COUNT(CASE WHEN pr.status = 'CONNECTION_ERROR' THEN 1 END) AS connection_error_count,
              COUNT(CASE WHEN pr.status = 'HTTP_ERROR' THEN 1 END) AS http_error_count,
              COUNT(CASE WHEN pr.status = 'DNS_ERROR' THEN 1 END) AS dns_error_count,
              COUNT(CASE WHEN pr.ip_changed = TRUE THEN 1 END) AS rotation_count,
              AVG(pr.download_speed_mbps) AS avg_download_speed_mbps,
              AVG(pr.upload_speed_mbps) AS avg_upload_speed_mbps,
              MAX(pr.download_speed_mbps) AS max_download_speed_mbps,
              MAX(pr.upload_speed_mbps) AS max_upload_speed_mbps,
              MIN(pr.download_speed_mbps) AS min_download_speed_mbps,
              MIN(pr.upload_speed_mbps) AS min_upload_speed_mbps,
              COUNT(DISTINCT pr.outbound_ip) AS unique_ips_count,
              ROUND(COUNT(DISTINCT pr.outbound_ip) / COUNT(*) * 100, 2) AS ip_diversity_score
            FROM proxy_requests pr
            LEFT JOIN proxies p ON pr.proxy_id = p.device_id
            WHERE DATE(pr.timestamp) = ?
              AND pr.timestamp IS NOT NULL
            GROUP BY DATE(pr.timestamp), pr.proxy_id, p.location, p.relay_server_id, p.relay_server_ip_address
          ) AS dt
          ON DUPLICATE KEY UPDATE
            relay_server_id = dt.relay_server_id,
            relay_server_ip = dt.relay_server_ip,
            total_requests = dt.total_requests,
            success_count = dt.success_count,
            failure_count = dt.failure_count,
            success_rate_pct = dt.success_rate_pct,
            avg_response_time_ms = dt.avg_response_time_ms,
            min_response_time_ms = dt.min_response_time_ms,
            max_response_time_ms = dt.max_response_time_ms,
            timeout_count = dt.timeout_count,
            connection_error_count = dt.connection_error_count,
            http_error_count = dt.http_error_count,
            dns_error_count = dt.dns_error_count,
            rotation_count = dt.rotation_count,
            avg_download_speed_mbps = dt.avg_download_speed_mbps,
            avg_upload_speed_mbps = dt.avg_upload_speed_mbps,
            max_download_speed_mbps = dt.max_download_speed_mbps,
            max_upload_speed_mbps = dt.max_upload_speed_mbps,
            min_download_speed_mbps = dt.min_download_speed_mbps,
            min_upload_speed_mbps = dt.min_upload_speed_mbps,
            unique_ips_count = dt.unique_ips_count,
            ip_diversity_score = dt.ip_diversity_score,
            updated_at = CURRENT_TIMESTAMP
        `, dayDate);
      } else {
        throw error;
      }
    }

    // Get count of proxies aggregated
    const result = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT COUNT(DISTINCT proxy_id) as count FROM proxy_requests_daily_summary WHERE day = ?`,
      dayDate
    );
    const proxyCount = Number(result[0]?.count || 0);

    logger.info(
      { day: dayDate, proxyCount },
      'Daily aggregation completed successfully'
    );
    return proxyCount;
  } catch (error) {
    logger.error(
      {
        error: error instanceof Error ? error.message : 'Unknown error',
        day: dayDate,
      },
      'Failed to aggregate daily summary'
    );
    return 0;
  }
}

/**
 * Aggregates data for the last N days (useful for initial population or catch-up)
 */
export async function aggregateRecentDays(days: number = 7): Promise<number> {
  let aggregated = 0;
  const now = new Date();

  for (let i = 1; i <= days; i++) {
    const day = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
    const result = await aggregateDailySummary(day);
    aggregated += result;
    
    // Small delay to avoid overwhelming the database
    if (i < days) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  logger.info({ days, aggregated }, 'Aggregated recent daily summaries');
  return aggregated;
}

/**
 * Rebuilds daily summary rows for each calendar day from start through end (inclusive).
 * Only days that still have rows in proxy_requests can produce summary data (see retention / cleanup).
 */
export async function aggregateDateRangeInclusive(start: Date, end: Date): Promise<number> {
  const startDay = new Date(start);
  startDay.setHours(0, 0, 0, 0);
  const endDay = new Date(end);
  endDay.setHours(0, 0, 0, 0);
  if (endDay < startDay) {
    logger.warn({ start: startDay, end: endDay }, 'aggregateDateRangeInclusive: end before start, skipping');
    return 0;
  }

  let proxyRowsTotal = 0;
  for (let d = new Date(startDay); d <= endDay; d.setDate(d.getDate() + 1)) {
    const n = await aggregateDailySummary(new Date(d));
    proxyRowsTotal += n;
    if (d.getTime() < endDay.getTime()) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  logger.info(
    {
      from: startDay.toISOString().split('T')[0],
      to: endDay.toISOString().split('T')[0],
      proxyRowsTotal,
    },
    'Aggregated daily summaries for date range'
  );
  return proxyRowsTotal;
}

/**
 * Starts the daily aggregation service
 * Runs once per day (typically at midnight or early morning) to aggregate previous day's data
 */
export function startDailyAggregationService(): void {
  if (isRunning) {
    logger.warn('Daily aggregation service is already running');
    return;
  }

  isRunning = true;
  logger.info('Starting daily aggregation service');

  // Calculate time until next midnight (or 1 AM for safety)
  const now = new Date();
  const nextRun = new Date(now);
  nextRun.setDate(nextRun.getDate() + 1);
  nextRun.setHours(1, 0, 0, 0); // 1 AM next day
  const msUntilNextRun = nextRun.getTime() - now.getTime();

  logger.info(
    {
      nextRun: nextRun.toISOString(),
      hoursUntilNextRun: (msUntilNextRun / (60 * 60 * 1000)).toFixed(2),
    },
    'Scheduled daily aggregation'
  );

  // Run first aggregation after calculated delay
  setTimeout(() => {
    void aggregateDailySummary();
    
    // Then run every 24 hours
    aggregationInterval = setInterval(() => {
      void aggregateDailySummary();
    }, 24 * 60 * 60 * 1000); // 24 hours
  }, msUntilNextRun);
}

/**
 * Stops the daily aggregation service
 */
export function stopDailyAggregationService(): void {
  if (aggregationInterval) {
    clearInterval(aggregationInterval);
    aggregationInterval = null;
  }
  isRunning = false;
  logger.info('Daily aggregation service stopped');
}

