/**
 * Hourly Summary Service
 * 
 * Populates the proxy_requests_hourly_summary table with pre-aggregated data
 * to improve Grafana query performance. Runs periodically to update summaries.
 * 
 * @module services/hourly-summary
 */

import { logger } from '../lib/logger';
import { prisma } from '../lib/db';
import { checkDatabaseHealth } from '../lib/db';

let summaryInterval: NodeJS.Timeout | null = null;
let isRunning = false;

/**
 * Populates hourly summary for a specific hour
 * 
 * @param hour - The hour to summarize (will be rounded down to hour boundary)
 */
export async function populateHourlySummary(hour?: Date): Promise<number> {
  const dbHealth = await checkDatabaseHealth();
  if (!dbHealth.connected) {
    logger.error('Database not connected, skipping hourly summary population');
    return 0;
  }

  // Default to previous hour if not specified
  const targetHour = hour || new Date(Date.now() - 60 * 60 * 1000);
  const hourStart = new Date(targetHour);
  hourStart.setMinutes(0, 0, 0);

  try {
    logger.debug({ hour: hourStart.toISOString() }, 'Populating hourly summary');

    // Use stored procedure if available, otherwise use direct SQL
    try {
      await prisma.$executeRawUnsafe(
        `CALL populate_hourly_summary(?)`,
        hourStart
      );
    } catch (error: any) {
      // If stored procedure doesn't exist, use direct SQL
      if (error?.message?.includes('does not exist') || error?.code === '42000') {
        logger.debug('Stored procedure not found, using direct SQL');
        
        const hourStartStr = hourStart.toISOString().slice(0, 19).replace('T', ' ');
        const hourEnd = new Date(hourStart);
        hourEnd.setHours(hourEnd.getHours() + 1);
        const hourEndStr = hourEnd.toISOString().slice(0, 19).replace('T', ' ');

        await prisma.$executeRawUnsafe(`
          INSERT INTO proxy_requests_hourly_summary (
            hour,
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
            avg_upload_speed_mbps
          )
          SELECT 
            DATE_FORMAT(pr.timestamp, '%Y-%m-%d %H:00:00') as hour,
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
            AVG(pr.upload_speed_mbps) as avg_upload_speed_mbps
          FROM proxy_requests pr
          LEFT JOIN proxies p ON pr.proxy_id = p.device_id
          WHERE pr.timestamp >= ?
            AND pr.timestamp < ?
            AND pr.timestamp IS NOT NULL
          GROUP BY hour, pr.proxy_id, p.location
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
            updated_at = CURRENT_TIMESTAMP
        `, hourStartStr, hourEndStr);
      } else {
        throw error;
      }
    }

    logger.info({ hour: hourStart.toISOString() }, 'Hourly summary populated successfully');
    return 1;
  } catch (error) {
    logger.error(
      {
        error: error instanceof Error ? error.message : 'Unknown error',
        hour: hourStart.toISOString(),
      },
      'Failed to populate hourly summary'
    );
    return 0;
  }
}

/**
 * Populates summaries for the last N hours (useful for initial population)
 */
export async function populateRecentSummaries(hours: number = 24): Promise<number> {
  let populated = 0;
  const now = new Date();

  for (let i = 1; i <= hours; i++) {
    const hour = new Date(now.getTime() - i * 60 * 60 * 1000);
    const result = await populateHourlySummary(hour);
    populated += result;
    
    // Small delay to avoid overwhelming the database
    if (i < hours) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  logger.info({ hours, populated }, 'Populated recent hourly summaries');
  return populated;
}

/**
 * Starts the hourly summary service
 * Runs every hour to populate the summary table
 */
export function startHourlySummaryService(): void {
  if (isRunning) {
    logger.warn('Hourly summary service is already running');
    return;
  }

  isRunning = true;
  logger.info('Starting hourly summary service');

  // Populate previous hour immediately
  void populateHourlySummary();

  // Then run every hour
  summaryInterval = setInterval(() => {
    void populateHourlySummary();
  }, 60 * 60 * 1000); // 1 hour
}

/**
 * Stops the hourly summary service
 */
export function stopHourlySummaryService(): void {
  if (summaryInterval) {
    clearInterval(summaryInterval);
    summaryInterval = null;
  }
  isRunning = false;
  logger.info('Hourly summary service stopped');
}

