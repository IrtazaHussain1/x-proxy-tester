/**
 * Auto-Deactivation and Recovery Service
 * 
 * This service handles automatic deactivation of failing proxies and
 * reactivation of recovered proxies based on configurable thresholds.
 * 
 * Auto-Deactivation:
 * - Deactivates proxies that exceed consecutive failure threshold
 * - Deactivates proxies that exceed failure rate threshold in recent requests
 * 
 * Auto-Recovery:
 * - Periodically checks deactivated proxies for recovery
 * - Reactivates proxies that show consecutive successful requests
 * 
 * @module services/auto-deactivation
 */

import { prismaWithRetry as prisma } from '../lib/db';
import { logger } from '../lib/logger';
import { config } from '../config';

/**
 * Check if a proxy should be auto-deactivated based on failure patterns
 * 
 * @param deviceId - Device ID of the proxy to check
 * @returns Object with shouldDeactivate flag and reason
 */
export async function checkAutoDeactivation(deviceId: string): Promise<{
  shouldDeactivate: boolean;
  reason?: string;
  consecutiveFailures?: number;
  failureRate?: number;
}> {
  if (!config.autoDeactivation.enabled) {
    return { shouldDeactivate: false };
  }

  try {
    // Get recent requests for failure analysis
    const recentRequests = await prisma.proxyRequest.findMany({
      where: {
        proxyId: deviceId,
      },
      orderBy: {
        timestamp: 'desc',
      },
      take: Math.max(
        config.autoDeactivation.consecutiveFailureThreshold,
        config.autoDeactivation.failureRateWindowSize
      ),
    });

    if (recentRequests.length === 0) {
      return { shouldDeactivate: false };
    }

    // Check consecutive failures from the most recent request
    let consecutiveFailures = 0;
    for (const request of recentRequests) {
      if (request.status === 'SUCCESS') {
        break; // Stop counting when we hit a success
      }
      consecutiveFailures++;
    }

    // Check if consecutive failure threshold is exceeded
    if (consecutiveFailures >= config.autoDeactivation.consecutiveFailureThreshold) {
      return {
        shouldDeactivate: true,
        reason: 'consecutive_failures',
        consecutiveFailures,
      };
    }

    // Check failure rate in the window
    const windowRequests = recentRequests.slice(0, config.autoDeactivation.failureRateWindowSize);
    if (windowRequests.length >= 10) {
      // Only check if we have enough data (at least 10 requests)
      const failedCount = windowRequests.filter((r) => r.status !== 'SUCCESS').length;
      const failureRate = failedCount / windowRequests.length;

      if (failureRate >= config.autoDeactivation.failureRateThreshold) {
        return {
          shouldDeactivate: true,
          reason: 'failure_rate',
          failureRate,
          consecutiveFailures,
        };
      }
    }

    return {
      shouldDeactivate: false,
      consecutiveFailures,
      failureRate: windowRequests.length > 0
        ? windowRequests.filter((r) => r.status !== 'SUCCESS').length / windowRequests.length
        : undefined,
    };
  } catch (error) {
    logger.error(
      {
        deviceId,
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      'Failed to check auto-deactivation'
    );
    return { shouldDeactivate: false };
  }
}

/**
 * Auto-deactivate a proxy based on failure patterns
 * 
 * @param deviceId - Device ID of the proxy to deactivate
 * @param reason - Reason for deactivation
 * @param metadata - Additional metadata about the deactivation
 */
export async function autoDeactivateProxy(
  deviceId: string,
  reason: string,
  metadata?: { consecutiveFailures?: number; failureRate?: number }
): Promise<void> {
  if (!config.autoDeactivation.enabled) {
    return;
  }

  try {
    const proxy = await prisma.proxy.findUnique({
      where: { deviceId },
      select: { active: true },
    });

    if (!proxy) {
      logger.warn({ deviceId }, 'Proxy not found for auto-deactivation');
      return;
    }

    // Only deactivate if currently active
    if (!proxy.active) {
      return; // Already deactivated
    }

    await prisma.proxy.update({
      where: { deviceId },
      data: { active: false },
    });

    logger.warn(
      {
        deviceId,
        reason,
        consecutiveFailures: metadata?.consecutiveFailures,
        failureRate: metadata?.failureRate,
      },
      '🚫 Proxy auto-deactivated due to failures'
    );
  } catch (error) {
    logger.error(
      {
        deviceId,
        reason,
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      'Failed to auto-deactivate proxy'
    );
  }
}

/**
 * Check if a deactivated proxy has recovered and should be reactivated
 * 
 * @param deviceId - Device ID of the proxy to check
 * @returns Object with shouldReactivate flag and consecutive successes
 */
export async function checkAutoRecovery(deviceId: string): Promise<{
  shouldReactivate: boolean;
  consecutiveSuccesses?: number;
}> {
  if (!config.autoRecovery.enabled) {
    return { shouldReactivate: false };
  }

  try {
    const proxy = await prisma.proxy.findUnique({
      where: { deviceId },
      select: { active: true },
    });

    if (!proxy || proxy.active) {
      return { shouldReactivate: false }; // Not deactivated or doesn't exist
    }

    // Get recent requests to check for recovery
    const recentRequests = await prisma.proxyRequest.findMany({
      where: {
        proxyId: deviceId,
      },
      orderBy: {
        timestamp: 'desc',
      },
      take: config.autoRecovery.consecutiveSuccessThreshold,
    });

    if (recentRequests.length < config.autoRecovery.consecutiveSuccessThreshold) {
      return { shouldReactivate: false }; // Not enough data
    }

    // Check if all recent requests are successful
    const allSuccessful = recentRequests.every((r) => r.status === 'SUCCESS');
    const consecutiveSuccesses = recentRequests.filter((r) => r.status === 'SUCCESS').length;

    if (allSuccessful && consecutiveSuccesses >= config.autoRecovery.consecutiveSuccessThreshold) {
      return {
        shouldReactivate: true,
        consecutiveSuccesses,
      };
    }

    return {
      shouldReactivate: false,
      consecutiveSuccesses,
    };
  } catch (error) {
    logger.error(
      {
        deviceId,
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      'Failed to check auto-recovery'
    );
    return { shouldReactivate: false };
  }
}

/**
 * Auto-reactivate a proxy that has recovered
 * 
 * @param deviceId - Device ID of the proxy to reactivate
 * @param consecutiveSuccesses - Number of consecutive successes that triggered reactivation
 * @param onReactivated - Optional callback when proxy is reactivated (to start testing)
 */
export async function autoReactivateProxy(
  deviceId: string,
  consecutiveSuccesses: number,
  onReactivated?: (deviceId: string) => void | Promise<void>
): Promise<void> {
  if (!config.autoRecovery.enabled) {
    return;
  }

  try {
    const proxy = await prisma.proxy.findUnique({
      where: { deviceId },
      select: { active: true },
    });

    if (!proxy) {
      logger.warn({ deviceId }, 'Proxy not found for auto-reactivation');
      return;
    }

    // Only reactivate if currently deactivated
    if (proxy.active) {
      return; // Already active
    }

    await prisma.proxy.update({
      where: { deviceId },
      data: { active: true },
    });

    logger.info(
      {
        deviceId,
        consecutiveSuccesses,
      },
      '✅ Proxy auto-reactivated after recovery'
    );

    // Call callback to start testing if provided
    if (onReactivated) {
      await onReactivated(deviceId);
    }
  } catch (error) {
    logger.error(
      {
        deviceId,
        consecutiveSuccesses,
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      'Failed to auto-reactivate proxy'
    );
  }
}

/**
 * Check all deactivated proxies for recovery and reactivate if recovered
 * 
 * @param onReactivated - Optional callback when proxy is reactivated (to start testing)
 */
export async function checkAllDeactivatedProxiesForRecovery(
  onReactivated?: (deviceId: string) => void | Promise<void>
): Promise<void> {
  if (!config.autoRecovery.enabled) {
    return;
  }

  try {
    const deactivatedProxies = await prisma.proxy.findMany({
      where: { active: false },
      select: { deviceId: true },
    });

    logger.debug(
      { count: deactivatedProxies.length },
      'Checking deactivated proxies for recovery'
    );

    const results = await Promise.allSettled(
      deactivatedProxies.map(async (proxy) => {
        const recoveryCheck = await checkAutoRecovery(proxy.deviceId);
        if (recoveryCheck.shouldReactivate && recoveryCheck.consecutiveSuccesses) {
          await autoReactivateProxy(
            proxy.deviceId,
            recoveryCheck.consecutiveSuccesses,
            onReactivated
          );
          return { deviceId: proxy.deviceId, reactivated: true };
        }
        return { deviceId: proxy.deviceId, reactivated: false };
      })
    );

    const reactivated = results.filter(
      (r) => r.status === 'fulfilled' && r.value.reactivated
    ).length;

    if (reactivated > 0) {
      logger.info(
        {
          totalChecked: deactivatedProxies.length,
          reactivated,
        },
        'Recovery check completed'
      );
    }
  } catch (error) {
    logger.error(
      {
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      'Failed to check deactivated proxies for recovery'
    );
  }
}

/**
 * Start periodic recovery checking for deactivated proxies
 * 
 * @param onReactivated - Optional callback when proxy is reactivated (to start testing)
 * @returns Interval handler
 */
export function startRecoveryChecking(
  onReactivated?: (deviceId: string) => void | Promise<void>
): NodeJS.Timeout {
  logger.info(
    { intervalMs: config.autoRecovery.checkIntervalMs },
    'Starting periodic recovery checking'
  );

  // Check immediately
  void checkAllDeactivatedProxiesForRecovery(onReactivated);

  // Then check periodically
  const interval = setInterval(() => {
    void checkAllDeactivatedProxiesForRecovery(onReactivated);
  }, config.autoRecovery.checkIntervalMs);

  return interval;
}

