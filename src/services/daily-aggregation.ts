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
        
        // Simplified aggregation without percentiles (for MySQL < 8.0)
        await prisma.$executeRawUnsafe(`
          INSERT INTO proxy_requests_daily_summary (
            day,
            proxy_id,
            location,
            total_requests,
            success_count,
            failure_count,
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
            unique_ips_count
          )
          SELECT 
            DATE(pr.timestamp) as day,
            pr.proxy_id,
            p.location,
            COUNT(*) as total_requests,
            COUNT(CASE WHEN pr.status = 'SUCCESS' THEN 1 END) as success_count,
            COUNT(CASE WHEN pr.status != 'SUCCESS' THEN 1 END) as failure_count,
            AVG(pr.response_time_ms) as avg_response_time_ms,
            MIN(pr.response_time_ms) as min_response_time_ms,
            MAX(pr.response_time_ms) as max_response_time_ms,
            COUNT(CASE WHEN pr.status = 'TIMEOUT' THEN 1 END) as timeout_count,
            COUNT(CASE WHEN pr.status = 'CONNECTION_ERROR' THEN 1 END) as connection_error_count,
            COUNT(CASE WHEN pr.status = 'HTTP_ERROR' THEN 1 END) as http_error_count,
            COUNT(CASE WHEN pr.status = 'DNS_ERROR' THEN 1 END) as dns_error_count,
            COUNT(CASE WHEN pr.ip_changed = true THEN 1 END) as rotation_count,
            AVG(pr.download_speed_mbps) as avg_download_speed_mbps,
            AVG(pr.upload_speed_mbps) as avg_upload_speed_mbps,
            MAX(pr.download_speed_mbps) as max_download_speed_mbps,
            MAX(pr.upload_speed_mbps) as max_upload_speed_mbps,
            MIN(pr.download_speed_mbps) as min_download_speed_mbps,
            MIN(pr.upload_speed_mbps) as min_upload_speed_mbps,
            COUNT(DISTINCT pr.outbound_ip) as unique_ips_count
          FROM proxy_requests pr
          LEFT JOIN proxies p ON pr.proxy_id = p.device_id
          WHERE DATE(pr.timestamp) = ?
            AND pr.timestamp IS NOT NULL
          GROUP BY day, pr.proxy_id, p.location
          ON DUPLICATE KEY UPDATE
            total_requests = VALUES(total_requests),
            success_count = VALUES(success_count),
            failure_count = VALUES(failure_count),
            avg_response_time_ms = VALUES(avg_response_time_ms),
            min_response_time_ms = VALUES(min_response_time_ms),
            max_response_time_ms = VALUES(max_response_time_ms),
            timeout_count = VALUES(timeout_count),
            connection_error_count = VALUES(connection_error_count),
            http_error_count = VALUES(http_error_count),
            dns_error_count = VALUES(dns_error_count),
            rotation_count = VALUES(rotation_count),
            avg_download_speed_mbps = VALUES(avg_download_speed_mbps),
            avg_upload_speed_mbps = VALUES(avg_upload_speed_mbps),
            max_download_speed_mbps = VALUES(max_download_speed_mbps),
            max_upload_speed_mbps = VALUES(max_upload_speed_mbps),
            min_download_speed_mbps = VALUES(min_download_speed_mbps),
            min_upload_speed_mbps = VALUES(min_upload_speed_mbps),
            unique_ips_count = VALUES(unique_ips_count),
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

