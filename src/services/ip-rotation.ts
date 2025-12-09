/**
 * IP Rotation Service
 * 
 * This service handles automatic IP rotation for all proxies using worker threads.
 * It automatically:
 * 1. Sends rotate IP or rotate unique IP command (in worker thread)
 * 2. Waits for the rotation to complete
 * 3. Checks if proxy has become active
 * 4. Resumes testing if active
 * 
 * Also provides periodic IP rotation that sends rotation commands to all devices
 * at regular intervals (default: every 10 minutes, configurable via PERIODIC_IP_ROTATION_INTERVAL_MS env var).
 * 
 * @module services/ip-rotation
 */

import { Worker } from 'worker_threads';
import { join } from 'path';
import { logger } from '../lib/logger';
import { prismaWithRetry as prisma } from '../lib/db';
import { config } from '../config';
import { getAllDevices } from '../helpers/devices';
import { rotateIp } from '../api/commands';
import type { Device } from '../types';

/**
 * Map to track devices that are currently being rotated
 * Prevents multiple simultaneous rotation attempts for the same device
 */
const rotationInProgress = new Map<string, Promise<boolean>>();

/**
 * Worker pool for IP rotation operations
 * Reuses workers to avoid overhead of creating new workers for each rotation
 */
const workerPool: Worker[] = [];
const MAX_WORKERS = 5; // Maximum number of concurrent worker threads
let workerIndex = 0;

/**
 * Cleanup all workers in the pool
 * Should be called on application shutdown
 */
export function cleanupWorkers(): void {
  logger.info({ workerCount: workerPool.length }, 'Cleaning up IP rotation worker threads');
  for (const worker of workerPool) {
    worker.terminate().catch((error) => {
      logger.error(
        { error: error instanceof Error ? error.message : 'Unknown error' },
        'Error terminating worker thread'
      );
    });
  }
  workerPool.length = 0;
}

/**
 * Get or create a worker from the pool
 * 
 * @returns Worker instance
 */
function getWorker(): Worker {
  // Round-robin worker selection
  if (workerPool.length < MAX_WORKERS) {
    // Use __dirname which will be dist/src/services when compiled
    const workerPath = join(__dirname, 'ip-rotation-worker.js');
    const worker = new Worker(workerPath, {
      // Enable worker to use ES modules if needed
      execArgv: [],
    });
    
    worker.on('error', (error) => {
      logger.error(
        { error: error.message },
        'Worker thread error'
      );
    });

    worker.on('exit', (code) => {
      if (code !== 0) {
        logger.warn(
          { exitCode: code },
          'Worker thread exited with non-zero code'
        );
      }
    });

    workerPool.push(worker);
    return worker;
  }

  // Use round-robin to distribute load
  const worker = workerPool[workerIndex % workerPool.length];
  workerIndex++;
  return worker;
}

/**
 * Rotate IP for a proxy using a worker thread
 * 
 * @param deviceId - Device ID to rotate IP for
 * @param useUniqueRotation - Whether to use unique IP rotation (default: false)
 * @returns Promise resolving to true if proxy became active, false otherwise
 */
export async function rotateIpForInactiveProxy(
  deviceId: string,
  useUniqueRotation: boolean = false
): Promise<boolean> {
  // Check if rotation is already in progress for this device
  const existingRotation = rotationInProgress.get(deviceId);
  if (existingRotation) {
    logger.debug({ deviceId }, 'IP rotation already in progress, waiting...');
    return existingRotation;
  }

  // Create rotation promise that uses worker thread
  const rotationPromise = (async (): Promise<boolean> => {
    const worker = getWorker();

    return new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => {
        worker.removeAllListeners('message');
        logger.error({ deviceId }, 'IP rotation worker timeout');
        resolve(false);
      }, 60000); // 60 second timeout

      worker.once('message', (message: {
        type: string;
        deviceId: string;
        success?: boolean;
        error?: string;
      }) => {
        clearTimeout(timeout);
        worker.removeAllListeners('message');

        if (message.type === 'rotation-complete') {
          resolve(message.success ?? false);
        } else if (message.type === 'rotation-error') {
          logger.error(
            {
              deviceId,
              error: message.error,
            },
            'IP rotation worker error'
          );
          resolve(false);
        }
      });

      // Send rotation command to worker
      worker.postMessage({
        type: 'rotate',
        deviceId,
        useUniqueRotation,
        waitAfterRotationMs: config.ipRotation.waitAfterRotationMs,
      });
    });
  })();

  // Store rotation promise
  rotationInProgress.set(deviceId, rotationPromise);

  // Clean up when promise resolves/rejects
  rotationPromise
    .finally(() => {
      rotationInProgress.delete(deviceId);
    })
    .catch(() => {
      // Errors are already handled in the promise
    });

  return rotationPromise;
}

/**
 * Check for proxies and attempt IP rotation (for all proxies, not just inactive)
 * 
 * @param devices - Array of all devices from portal
 * @param onProxyActivated - Callback when proxy becomes active (to start testing)
 */
export async function checkAndRotateInactiveProxies(
  devices: Device[],
  onProxyActivated?: (device: Device) => void | Promise<void>
): Promise<void> {
  if (!config.ipRotation.enabled) {
    return;
  }

  try {
    if (devices.length === 0) {
      return; // No devices
    }

    logger.debug(
      { count: devices.length },
      'Checking all proxies for IP rotation'
    );

    // Check each device (all proxies, not just inactive)
    const rotationPromises = devices.map(async (device) => {
      // Check if rotation is already in progress
      if (rotationInProgress.has(device.device_id)) {
        return;
      }

      // Check database to see if we've already tried rotating recently
      try {
        const proxy = await prisma.proxy.findUnique({
          where: { deviceId: device.device_id },
          select: {
            active: true,
            updatedAt: true,
          },
        });

        if (!proxy) {
          return; // Proxy not in database yet
        }

        // Skip if we've tried rotating recently (within cooldown period)
        const lastUpdate = proxy.updatedAt.getTime();
        const now = Date.now();
        const cooldownMs = config.ipRotation.rotationCooldownMs;

        if (now - lastUpdate < cooldownMs) {
          logger.debug(
            {
              deviceId: device.device_id,
              timeSinceLastUpdate: now - lastUpdate,
              cooldownMs,
            },
            'Skipping rotation - still in cooldown period'
          );
          return;
        }

        // Attempt rotation
        const useUniqueRotation = config.ipRotation.preferUniqueRotation;
        const becameActive = await rotateIpForInactiveProxy(
          device.device_id,
          useUniqueRotation
        );

        if (becameActive && onProxyActivated) {
          await onProxyActivated(device);
        }
      } catch (error) {
        logger.error(
          {
            deviceId: device.device_id,
            error: error instanceof Error ? error.message : 'Unknown error',
          },
          'Failed to check/rotate proxy'
        );
      }
    });

    await Promise.allSettled(rotationPromises);
  } catch (error) {
    logger.error(
      {
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      'Failed to check and rotate proxies'
    );
  }
}

/**
 * Start periodic checking for all proxies and trigger IP rotation
 * 
 * @param getDevices - Function to get current device list
 * @param onProxyActivated - Callback when proxy becomes active (to start testing)
 * @returns Interval handler
 */
export function startInactiveProxyRotation(
  getDevices: () => Promise<Device[]>,
  onProxyActivated?: (device: Device) => void | Promise<void>
): NodeJS.Timeout {
  logger.info(
    { intervalMs: config.ipRotation.checkIntervalMs },
    'Starting periodic IP rotation for all proxies'
  );

  // Check immediately
  void (async () => {
    const devices = await getDevices();
    await checkAndRotateInactiveProxies(devices, onProxyActivated);
  })();

  // Then check periodically
  const interval = setInterval(async () => {
    try {
      const devices = await getDevices();
      await checkAndRotateInactiveProxies(devices, onProxyActivated);
    } catch (error) {
      logger.error(
        {
          error: error instanceof Error ? error.message : 'Unknown error',
        },
        'Failed to check proxies for rotation'
      );
    }
  }, config.ipRotation.checkIntervalMs);

  return interval;
}

/**
 * Periodic IP Rotation State
 * Tracks the periodic rotation interval and running status
 */
let periodicRotationInterval: NodeJS.Timeout | null = null;
let periodicRotationRunning = false;

/**
 * Send IP rotation command to a single device
 * 
 * @param deviceId - Device ID to rotate IP for
 * @returns Promise resolving to true if command was sent successfully
 */
async function sendRotationCommand(deviceId: string): Promise<boolean> {
  try {
    const response = await rotateIp(deviceId);
    if (response.success) {
      logger.debug(
        { deviceId, message: response.message },
        'IP rotation command sent successfully'
      );
      return true;
    } else {
      logger.warn(
        { deviceId, message: response.message },
        'IP rotation command failed'
      );
      return false;
    }
  } catch (error) {
    logger.error(
      {
        deviceId,
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      'Failed to send IP rotation command'
    );
    return false;
  }
}

/**
 * Send IP rotation commands to all devices
 * 
 * Fetches all devices and sends rotation command to each one in parallel.
 * Errors for individual devices are logged but don't stop the process.
 */
async function rotateAllDevices(): Promise<void> {
  try {
    const devices = await getAllDevices();
    
    if (devices.length === 0) {
      logger.debug('No devices found, skipping IP rotation');
      return;
    }

    logger.debug(
      { deviceCount: devices.length },
      `Sending IP rotation commands to ${devices.length} devices`
    );

    // Send rotation commands to all devices in parallel
    const rotationPromises = devices.map((device) =>
      sendRotationCommand(device.device_id)
    );

    const results = await Promise.allSettled(rotationPromises);
    
    const successful = results.filter((r) => r.status === 'fulfilled' && r.value).length;
    const failed = results.length - successful;

    logger.info(
      {
        total: devices.length,
        successful,
        failed,
      },
      `IP rotation commands sent: ${successful}/${devices.length} successful`
    );
  } catch (error) {
    logger.error(
      {
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      'Failed to rotate all devices'
    );
  }
}

/**
 * Start periodic IP rotation service
 * 
 * Sends IP rotation commands to all devices at the configured interval.
 * Default interval is 10 minutes (600000ms), configurable via PERIODIC_IP_ROTATION_INTERVAL_MS env var.
 * 
 * @param intervalMs - Interval in milliseconds between rotation cycles (default: 600000)
 * @returns Interval handler that can be used to stop the service
 */
export function startPeriodicIpRotation(intervalMs: number = 600000): NodeJS.Timeout {
  if (periodicRotationRunning) {
    logger.warn('Periodic IP rotation is already running');
    return periodicRotationInterval!;
  }

  periodicRotationRunning = true;
  logger.info(
    { intervalMs, intervalSeconds: intervalMs / 1000 },
    'Starting periodic IP rotation service'
  );

  // Rotate immediately on start
  void rotateAllDevices();

  // Then rotate at configured interval
  periodicRotationInterval = setInterval(() => {
    void rotateAllDevices();
  }, intervalMs);

  return periodicRotationInterval;
}

/**
 * Stop periodic IP rotation service
 * 
 * Clears the rotation interval and stops sending commands.
 * Safe to call multiple times (idempotent).
 */
export function stopPeriodicIpRotation(): void {
  if (!periodicRotationRunning) {
    return;
  }

  periodicRotationRunning = false;

  if (periodicRotationInterval) {
    clearInterval(periodicRotationInterval);
    periodicRotationInterval = null;
  }

  logger.info('Periodic IP rotation service stopped');
}

/**
 * Get the current status of periodic IP rotation service
 * 
 * @returns Status object with isRunning flag
 */
export function getPeriodicIpRotationStatus(): { isRunning: boolean } {
  return { isRunning: periodicRotationRunning };
}

