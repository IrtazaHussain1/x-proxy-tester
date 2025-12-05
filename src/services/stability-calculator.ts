/**
 * Stability Calculator Service
 * 
 * Calculates and updates proxy stability status based on downtime metrics.
 * 
 * Stability Criteria:
 * - **Stable**: No issues detected
 * - **UnstableHourly**: Down more than 10 minutes within any 1-hour sliding window
 * - **UnstableDaily**: Down more than 1 hour within any 24-hour sliding window
 * 
 * The service runs periodically (default: every 10 minutes) and checks all active proxies.
 * 
 * @module services/stability-calculator
 */

import { prismaWithRetry as prisma } from '../lib/db';
import { logger } from '../lib/logger';
import { config } from '../config';
import type { StabilityStatus } from '../types';

/**
 * Stability thresholds in milliseconds
 */
const UNSTABLE_HOURLY_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes
const UNSTABLE_DAILY_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour

/**
 * Calculates downtime in milliseconds based on failed request count
 * 
 * Downtime = number of failed requests × test interval
 * 
 * @param failedCount - Number of failed requests in the time window
 * @returns Total downtime in milliseconds
 */
function calculateDowntime(failedCount: number): number {
  return failedCount * config.testing.intervalMs;
}

/**
 * Check if proxy is unstable within a 1-hour window
 * Unstable if down more than 10 minutes (600,000ms) in any 1-hour window
 * 
 * @param deviceId - Device ID (primary key) of the proxy
 */
async function checkHourlyStability(deviceId: string): Promise<boolean> {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

  // Get all requests in the last hour
  const requests = await prisma.proxyRequest.findMany({
    where: {
      proxyId: deviceId,
      timestamp: {
        gte: oneHourAgo,
      },
    },
    orderBy: {
      timestamp: 'asc',
    },
  });

  if (requests.length === 0) {
    return false; // No data, can't determine instability
  }

  // Filter failed requests (non-SUCCESS) for window analysis

  // Check if any 1-hour sliding window has >10min downtime
  // We'll check the current window and previous windows
  const windowSize = 60 * 60 * 1000; // 1 hour
  const now = Date.now();

  // Check multiple 1-hour windows in the last 2 hours
  for (let windowStart = now - 2 * windowSize; windowStart <= now; windowStart += 10 * 60 * 1000) {
    // Slide window by 10 minutes
    const windowEnd = windowStart + windowSize;
    const windowStartDate = new Date(windowStart);
    const windowEndDate = new Date(windowEnd);

    const windowRequests = requests.filter(
      (r) => r.timestamp >= windowStartDate && r.timestamp <= windowEndDate
    );
    const windowFailed = windowRequests.filter((r) => r.status !== 'SUCCESS');
    const windowDowntimeMs = calculateDowntime(windowFailed.length);

    if (windowDowntimeMs > UNSTABLE_HOURLY_THRESHOLD_MS) {
      logger.debug(
        {
          deviceId,
          windowStart: windowStartDate.toISOString(),
          windowEnd: windowEndDate.toISOString(),
          failedCount: windowFailed.length,
          downtimeMs: windowDowntimeMs,
        },
        'Proxy unstable in hourly window'
      );
      return true;
    }
  }

  return false;
}

/**
 * Check if proxy is unstable within a 24-hour window
 * Unstable if down more than 1 hour (3,600,000ms) in any 24-hour window
 * 
 * @param deviceId - Device ID (primary key) of the proxy
 */
async function checkDailyStability(deviceId: string): Promise<boolean> {
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

  // Get all requests in the last 24 hours
  const requests = await prisma.proxyRequest.findMany({
    where: {
      proxyId: deviceId,
      timestamp: {
        gte: oneDayAgo,
      },
    },
    orderBy: {
      timestamp: 'asc',
    },
  });

  if (requests.length === 0) {
    return false; // No data, can't determine instability
  }

  // Filter failed requests (non-SUCCESS) for window analysis

  // Check if any 24-hour sliding window has >1hour downtime
  const windowSize = 24 * 60 * 60 * 1000; // 24 hours
  const now = Date.now();

  // Check multiple 24-hour windows in the last 2 days
  for (let windowStart = now - 2 * windowSize; windowStart <= now; windowStart += 60 * 60 * 1000) {
    // Slide window by 1 hour
    const windowEnd = windowStart + windowSize;
    const windowStartDate = new Date(windowStart);
    const windowEndDate = new Date(windowEnd);

    const windowRequests = requests.filter(
      (r) => r.timestamp >= windowStartDate && r.timestamp <= windowEndDate
    );
    const windowFailed = windowRequests.filter((r) => r.status !== 'SUCCESS');
    const windowDowntimeMs = calculateDowntime(windowFailed.length);

    if (windowDowntimeMs > UNSTABLE_DAILY_THRESHOLD_MS) {
      logger.debug(
        {
          deviceId,
          windowStart: windowStartDate.toISOString(),
          windowEnd: windowEndDate.toISOString(),
          failedCount: windowFailed.length,
          downtimeMs: windowDowntimeMs,
        },
        'Proxy unstable in daily window'
      );
      return true;
    }
  }

  return false;
}

/**
 * Calculate and update stability status for a single proxy
 * 
 * @param deviceId - Device ID (primary key) of the proxy
 * @returns Calculated stability status
 */
export async function calculateProxyStability(deviceId: string): Promise<StabilityStatus> {
  try {
    // Check daily stability first (more severe)
    const isUnstableDaily = await checkDailyStability(deviceId);
    if (isUnstableDaily) {
      await prisma.proxy.update({
        where: { deviceId },
        data: { stabilityStatus: 'UnstableDaily' },
      });
      return 'UnstableDaily';
    }

    // Check hourly stability
    const isUnstableHourly = await checkHourlyStability(deviceId);
    if (isUnstableHourly) {
      await prisma.proxy.update({
        where: { deviceId },
        data: { stabilityStatus: 'UnstableHourly' },
      });
      return 'UnstableHourly';
    }

    // If neither, mark as stable
    await prisma.proxy.update({
      where: { deviceId },
      data: { stabilityStatus: 'Stable' },
    });
    return 'Stable';
  } catch (error) {
    logger.error(
      {
        deviceId,
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      'Failed to calculate proxy stability'
    );
    return 'Unknown';
  }
}

/**
 * Calculate stability for all active proxies
 */
export async function calculateAllProxiesStability(): Promise<void> {
  try {
    const proxies = await prisma.proxy.findMany({
      where: { active: true },
      select: { deviceId: true },
    });

    logger.info({ count: proxies.length }, 'Calculating stability for all proxies');

    const results = await Promise.allSettled(
      proxies.map((proxy) => calculateProxyStability(proxy.deviceId))
    );

    const successful = results.filter((r) => r.status === 'fulfilled').length;
    const failed = results.length - successful;

    // Count stability statuses
    const statusCounts: Record<string, number> = {};
    for (const result of results) {
      if (result.status === 'fulfilled') {
        const status = result.value;
        statusCounts[status] = (statusCounts[status] || 0) + 1;
      }
    }

    logger.info(
      {
        total: proxies.length,
        successful,
        failed,
        statusCounts,
      },
      'Stability calculation completed'
    );
  } catch (error) {
    logger.error(
      { error: error instanceof Error ? error.message : 'Unknown error' },
      'Failed to calculate stability for all proxies'
    );
  }
}

/**
 * Start periodic stability calculation
 * Runs every STABILITY_CHECK_INTERVAL_MS (default: 10 minutes)
 */
export function startStabilityCalculation(): NodeJS.Timeout {
  logger.info(
    { intervalMs: config.stability.checkIntervalMs },
    'Starting periodic stability calculation'
  );

  // Calculate immediately
  void calculateAllProxiesStability();

  // Then calculate periodically
  const interval = setInterval(() => {
    void calculateAllProxiesStability();
  }, config.stability.checkIntervalMs);

  return interval;
}

