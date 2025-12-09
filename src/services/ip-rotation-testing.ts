/**
 * IP Rotation Testing Service
 * 
 * This service manages a separate testing flow that:
 * 1. Rotates IPs for all active proxies every N minutes (configurable, default: 10 minutes)
 * 2. After rotation, extensively tests all proxies in quick succession
 * 3. Runs alongside the existing continuous testing flow
 * 4. Uses resource-efficient batching to prevent system exhaustion
 * 
 * @module services/ip-rotation-testing
 */

import { logger } from '../lib/logger';
import { config } from '../config';
import { getAllDevices } from '../helpers/devices';
import { testProxyWithStats } from '../helpers/test-proxy';
import { saveProxyTestToDatabase } from './continuous-proxy-tester';
import { rotateIp, rotateUniqueIp } from '../api/commands';
import { mapProxyStatusToActive } from './continuous-proxy-tester';
import { recordRequest } from '../lib/metrics';
import type { Device } from '../types';

/**
 * Module-level state
 */
let rotationInterval: NodeJS.Timeout | null = null;
let isRunning = false;
let currentCyclePromise: Promise<void> | null = null;

/**
 * Simple semaphore for concurrency control
 */
class Semaphore {
  private permits: number;
  private waitQueue: Array<() => void> = [];

  constructor(permits: number) {
    this.permits = permits;
  }

  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return;
    }

    return new Promise((resolve) => {
      this.waitQueue.push(resolve);
    });
  }

  release(): void {
    if (this.waitQueue.length > 0) {
      const next = this.waitQueue.shift();
      if (next) next();
    } else {
      this.permits++;
    }
  }
}

/**
 * Rotates IP for a single device with error handling
 * 
 * @param device - Device to rotate IP for
 * @param useUniqueRotation - Whether to use unique IP rotation
 * @returns Promise resolving to true if rotation succeeded, false otherwise
 */
async function rotateDeviceIp(
  device: Device,
  useUniqueRotation: boolean = false
): Promise<boolean> {
  try {
    const commandResponse = useUniqueRotation
      ? await rotateUniqueIp(device.device_id)
      : await rotateIp(device.device_id);

    if (!commandResponse.success) {
      logger.warn(
        {
          deviceId: device.device_id,
          deviceName: device.name,
          message: commandResponse.message,
          rotationType: useUniqueRotation ? 'unique' : 'standard',
        },
        'IP rotation command failed'
      );
      return false;
    }

    logger.debug(
      {
        deviceId: device.device_id,
        deviceName: device.name,
        rotationType: useUniqueRotation ? 'unique' : 'standard',
      },
      'IP rotation command sent successfully'
    );

    return true;
  } catch (error) {
    logger.error(
      {
        deviceId: device.device_id,
        deviceName: device.name,
        error: error instanceof Error ? error.message : 'Unknown error',
        rotationType: useUniqueRotation ? 'unique' : 'standard',
      },
      'Failed to rotate IP for device'
    );
    return false;
  }
}

/**
 * Rotates IPs for all active proxies in batches with concurrency control
 * 
 * @param devices - Array of active devices to rotate
 * @param concurrency - Maximum number of concurrent rotations
 * @returns Promise resolving to rotation statistics
 */
async function rotateAllProxies(
  devices: Device[],
  concurrency: number
): Promise<{ total: number; successful: number; failed: number }> {
  const semaphore = new Semaphore(concurrency);
  const total = devices.length;
  let successful = 0;
  let failed = 0;

  logger.info(
    {
      total,
      concurrency,
    },
    'Starting IP rotation for all active proxies'
  );

  const rotationStartTime = Date.now();

  // Use unique rotation if configured, otherwise standard rotation
  const useUniqueRotation = config.ipRotation.preferUniqueRotation;

  const rotationPromises = devices.map(async (device) => {
    await semaphore.acquire();
    try {
      const success = await rotateDeviceIp(device, useUniqueRotation);
      if (success) {
        successful++;
      } else {
        failed++;
      }
    } catch (error) {
      failed++;
      logger.error(
        {
          deviceId: device.device_id,
          deviceName: device.name,
          error: error instanceof Error ? error.message : 'Unknown error',
        },
        'Unexpected error during IP rotation'
      );
    } finally {
      semaphore.release();
    }
  });

  await Promise.allSettled(rotationPromises);

  const rotationDuration = Date.now() - rotationStartTime;

  logger.info(
    {
      total,
      successful,
      failed,
      successRate: total > 0 ? ((successful / total) * 100).toFixed(2) + '%' : '0%',
      durationMs: rotationDuration,
      durationSeconds: (rotationDuration / 1000).toFixed(2),
    },
    'IP rotation cycle completed'
  );

  return { total, successful, failed };
}

/**
 * Tests a single proxy and saves results to database
 * 
 * @param device - Device to test
 */
async function testAndSaveProxy(device: Device): Promise<void> {
  try {
    const metrics = await testProxyWithStats(device);
    
    // Record metrics
    recordRequest(metrics.success, metrics.responseTimeMs);
    
    await saveProxyTestToDatabase(device, metrics);
  } catch (error) {
    logger.error(
      {
        deviceId: device.device_id,
        deviceName: device.name,
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      'Failed to test proxy during rotation testing cycle'
    );
    recordRequest(false, 0);
  }
}

/**
 * Tests all proxies in batches with concurrency control
 * 
 * @param devices - Array of devices to test
 * @param concurrency - Maximum number of concurrent tests
 * @returns Promise resolving to test statistics
 */
async function extensivelyTestAllProxies(
  devices: Device[],
  concurrency: number
): Promise<{ total: number; successful: number; failed: number; avgResponseTime: number }> {
  const semaphore = new Semaphore(concurrency);
  const total = devices.length;
  let successful = 0;
  let failed = 0;
  const responseTimes: number[] = [];

  logger.info(
    {
      total,
      concurrency,
    },
    'Starting extensive testing of all proxies'
  );

  const testStartTime = Date.now();

  const testPromises = devices.map(async (device) => {
    await semaphore.acquire();
    try {
      const testStart = Date.now();
      await testAndSaveProxy(device);
      const testDuration = Date.now() - testStart;
      responseTimes.push(testDuration);
      successful++;
    } catch (error) {
      failed++;
      logger.error(
        {
          deviceId: device.device_id,
          deviceName: device.name,
          error: error instanceof Error ? error.message : 'Unknown error',
        },
        'Failed to test proxy'
      );
    } finally {
      semaphore.release();
    }
  });

  await Promise.allSettled(testPromises);

  const testDuration = Date.now() - testStartTime;
  const avgResponseTime =
    responseTimes.length > 0
      ? responseTimes.reduce((sum, time) => sum + time, 0) / responseTimes.length
      : 0;

  logger.info(
    {
      total,
      successful,
      failed,
      successRate: total > 0 ? ((successful / total) * 100).toFixed(2) + '%' : '0%',
      avgResponseTimeMs: Math.round(avgResponseTime),
      durationMs: testDuration,
      durationSeconds: (testDuration / 1000).toFixed(2),
    },
    'Extensive testing cycle completed'
  );

  return { total, successful, failed, avgResponseTime };
}

/**
 * Executes a complete rotation and testing cycle
 * 
 * 1. Fetches all active devices
 * 2. Rotates IPs for all active proxies
 * 3. Waits for rotation to complete
 * 4. Extensively tests all proxies
 */
async function executeRotationCycle(): Promise<void> {
  const cycleStartTime = Date.now();

  logger.info('🔄 Starting IP rotation testing cycle');

  try {
    // Fetch all devices from portal
    const allDevices = await getAllDevices();

    // Filter to only active devices (both portal and DB active status)
    const activeDevices = allDevices.filter((device) =>
      mapProxyStatusToActive(device.proxy_status)
    );

    if (activeDevices.length === 0) {
      logger.warn('No active devices found, skipping rotation cycle');
      return;
    }

    logger.info(
      {
        totalDevices: allDevices.length,
        activeDevices: activeDevices.length,
      },
      'Fetched devices for rotation cycle'
    );

    // Step 1: Rotate IPs for all active proxies
    const rotationStats = await rotateAllProxies(
      activeDevices,
      config.ipRotationTesting.testConcurrency
    );

    // Step 2: Wait for rotation to complete
    const waitTime = config.ipRotationTesting.waitAfterRotationMs;
    logger.info(
      {
        waitTimeMs: waitTime,
        waitTimeSeconds: (waitTime / 1000).toFixed(2),
      },
      `Waiting ${waitTime}ms for IP rotations to complete`
    );
    await new Promise((resolve) => setTimeout(resolve, waitTime));

    // Step 3: Extensively test all proxies
    const testStats = await extensivelyTestAllProxies(
      activeDevices,
      config.ipRotationTesting.testConcurrency
    );

    const cycleDuration = Date.now() - cycleStartTime;

    // Log cycle summary
    logger.info(
      {
        cycleDurationMs: cycleDuration,
        cycleDurationSeconds: (cycleDuration / 1000).toFixed(2),
        rotationStats,
        testStats,
      },
      '✅ IP rotation testing cycle completed successfully'
    );
  } catch (error) {
    const cycleDuration = Date.now() - cycleStartTime;
    logger.error(
      {
        error: error instanceof Error ? error.message : 'Unknown error',
        errorStack: error instanceof Error ? error.stack : undefined,
        cycleDurationMs: cycleDuration,
      },
      '❌ IP rotation testing cycle failed'
    );
  }
}

/**
 * Starts the IP rotation testing service
 * 
 * Sets up a periodic interval to execute rotation and testing cycles.
 * Runs alongside the continuous testing flow without conflicts.
 * 
 * @returns Interval handler (can be used to stop the service)
 * 
 * @example
 * ```typescript
 * const interval = startIpRotationTesting();
 * // Service is now running, will rotate and test every 10 minutes
 * 
 * // To stop:
 * clearInterval(interval);
 * stopIpRotationTesting();
 * ```
 */
export function startIpRotationTesting(): NodeJS.Timeout {
  if (isRunning) {
    logger.warn('IP rotation testing is already running');
    return rotationInterval!;
  }

  if (!config.ipRotationTesting.enabled) {
    logger.info('IP rotation testing is disabled');
    return setInterval(() => {}, 0); // Return dummy interval
  }

  isRunning = true;

  logger.info(
    {
      rotationIntervalMs: config.ipRotationTesting.rotationIntervalMs,
      rotationIntervalMinutes: (config.ipRotationTesting.rotationIntervalMs / 60000).toFixed(1),
      waitAfterRotationMs: config.ipRotationTesting.waitAfterRotationMs,
      testConcurrency: config.ipRotationTesting.testConcurrency,
      batchSize: config.ipRotationTesting.batchSize,
    },
    'Starting IP rotation testing service'
  );

  // Execute first cycle immediately
  void (async () => {
    currentCyclePromise = executeRotationCycle();
    await currentCyclePromise;
    currentCyclePromise = null;
  })();

  // Then execute periodically
  rotationInterval = setInterval(() => {
    // Don't start a new cycle if one is already running
    if (currentCyclePromise) {
      logger.warn(
        {
          intervalMs: config.ipRotationTesting.rotationIntervalMs,
        },
        'Previous rotation cycle still running, skipping this cycle'
      );
      return;
    }

    void (async () => {
      currentCyclePromise = executeRotationCycle();
      await currentCyclePromise;
      currentCyclePromise = null;
    })();
  }, config.ipRotationTesting.rotationIntervalMs);

  return rotationInterval;
}

/**
 * Stops the IP rotation testing service
 * 
 * Clears the interval and waits for any running cycle to complete.
 * Safe to call multiple times (idempotent).
 */
export async function stopIpRotationTesting(): Promise<void> {
  if (!isRunning) {
    return;
  }

  isRunning = false;

  if (rotationInterval) {
    clearInterval(rotationInterval);
    rotationInterval = null;
  }

  // Wait for current cycle to complete if running
  if (currentCyclePromise) {
    logger.info('Waiting for current rotation cycle to complete...');
    try {
      await currentCyclePromise;
    } catch (error) {
      logger.error(
        {
          error: error instanceof Error ? error.message : 'Unknown error',
        },
        'Error waiting for rotation cycle to complete'
      );
    }
    currentCyclePromise = null;
  }

  logger.info('IP rotation testing service stopped');
}

/**
 * Gets the current status of the IP rotation testing service
 * 
 * @returns Status object with running state and configuration
 */
export function getIpRotationTestingStatus(): {
  isRunning: boolean;
  rotationIntervalMs: number;
  testConcurrency: number;
  isCycleRunning: boolean;
} {
  return {
    isRunning,
    rotationIntervalMs: config.ipRotationTesting.rotationIntervalMs,
    testConcurrency: config.ipRotationTesting.testConcurrency,
    isCycleRunning: currentCyclePromise !== null,
  };
}

