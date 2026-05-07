/**
 * IP Rotation Service
 * 
 * This service handles automatic IP rotation for inactive proxies using worker threads.
 * When a proxy becomes inactive in the portal, it automatically:
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
import { mapProxyStatusToActive } from './continuous-proxy-tester';
import { getAllDevices } from '../helpers/devices';

import type { Device } from '../types';
import {
  createRotationCycle,
  startRotationCycle,
  completeRotationCycle,
} from './rotation-cycle-manager';
import { verifyRotationCycle } from './rotation-verification';

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
 * Rotate IP for an inactive proxy using a worker thread
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
 * Check for inactive proxies and attempt IP rotation using rotation cycle manager
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
    const inactiveDevices = devices.filter(
      (d) => !mapProxyStatusToActive(d.proxy_status)
    );

    if (inactiveDevices.length === 0) {
      return; // No inactive devices
    }

    logger.debug(
      { count: inactiveDevices.length },
      'Checking inactive proxies for IP rotation'
    );

    // Filter devices that are not in cooldown
    const devicesToRotate: Device[] = [];
    
    for (const device of inactiveDevices) {
      // Check if rotation is already in progress
      if (rotationInProgress.has(device.device_id)) {
        continue;
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
          continue; // Proxy not in database yet
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
          continue;
        }

        devicesToRotate.push(device);
      } catch (error) {
        logger.error(
          {
            deviceId: device.device_id,
            error: error instanceof Error ? error.message : 'Unknown error',
          },
          'Failed to check proxy cooldown'
        );
      }
    }

    if (devicesToRotate.length === 0) {
      return; // No devices to rotate
    }

    const proxyIds = devicesToRotate.map((d) => d.device_id);
    const rotationType = config.ipRotation.preferUniqueRotation ? 'unique' : 'standard';

    // Create rotation cycle with shared timestamp
    const cycleId = await createRotationCycle('inactive_proxy', proxyIds);

    // Start rotation cycle - send commands
    await startRotationCycle(cycleId, proxyIds, rotationType);

    // Wait a bit before starting verification
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Verify rotations with adaptive retry
    await verifyRotationCycle(cycleId);

    // Complete cycle and update aggregates
    await completeRotationCycle(cycleId);

    // Check which proxies became active and trigger callback
    const cycle = await prisma.rotationCycle.findUnique({
      where: { id: cycleId },
      include: {
        rotations: {
          where: { success: true },
          select: { proxyId: true },
        },
      },
    });

    if (cycle && onProxyActivated) {
      const successfulProxyIds = new Set((cycle as any).rotations.map((r: any) => r.proxyId));
      for (const device of devicesToRotate) {
        if (successfulProxyIds.has(device.device_id)) {
          await onProxyActivated(device);
        }
      }
    }

    logger.info(
      {
        cycleId,
        total: devicesToRotate.length,
      },
      'Inactive proxy rotation cycle completed'
    );
  } catch (error) {
    logger.error(
      {
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      'Failed to check and rotate inactive proxies'
    );
  }
}

/**
 * Start periodic checking for inactive proxies and trigger IP rotation
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
    'Starting periodic inactive proxy IP rotation'
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
        'Failed to check inactive proxies for rotation'
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
let periodicRotationCyclePromise: Promise<void> | null = null;



/**
 * Send IP rotation commands to all devices using rotation cycle manager
 * 
 * Creates a rotation cycle with shared timestamp, sends commands, and verifies results.
 * Errors for individual devices are logged but don't stop the process.
 */
async function rotateAllDevices(): Promise<void> {
  let cycleId: string | null = null;
  try {
    const devices = await getAllDevices();
    
    if (devices.length === 0) {
      logger.debug('No devices found, skipping IP rotation');
      return;
    }

    const proxyIds = devices.map((d) => d.device_id);
    const rotationType = config.ipRotation.preferUniqueRotation ? 'unique' : 'standard';

    // Create rotation cycle with shared timestamp
    cycleId = await createRotationCycle('periodic', proxyIds);

    // Start rotation cycle - send commands
    await startRotationCycle(cycleId, proxyIds, rotationType);

    // Wait a bit before starting verification
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Verify rotations with adaptive retry
    await verifyRotationCycle(cycleId);

    // Complete cycle and update aggregates
    await completeRotationCycle(cycleId);

    logger.info(
      {
        cycleId,
        total: devices.length,
      },
      'Periodic IP rotation cycle completed'
    );
  } catch (error) {
    if (cycleId) {
      try {
        // Mark cycle as failed if execution stops before completion.
        await prisma.rotationCycle.updateMany({
          where: {
            id: cycleId,
            status: {
              in: ['in_progress', 'verifying'],
            },
          },
          data: {
            status: 'failed',
            pendingCount: 0,
          },
        });
      } catch (updateError) {
        logger.error(
          {
            cycleId,
            error: updateError instanceof Error ? updateError.message : 'Unknown error',
          },
          'Failed to mark periodic rotation cycle as failed'
        );
      }
    }

    logger.error(
      {
        cycleId,
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

  function triggerPeriodicRotation(): void {
    if (periodicRotationCyclePromise) {
      logger.warn(
        { intervalMs },
        'Previous periodic rotation cycle is still running, skipping this run'
      );
      return;
    }

    periodicRotationCyclePromise = rotateAllDevices()
      .catch(() => {
        // rotateAllDevices already logs detailed errors
      })
      .finally(() => {
        periodicRotationCyclePromise = null;
      });
  }

  // Rotate immediately on start
  triggerPeriodicRotation();

  // Then rotate at configured interval
  periodicRotationInterval = setInterval(() => {
    triggerPeriodicRotation();
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

  periodicRotationCyclePromise = null;

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

