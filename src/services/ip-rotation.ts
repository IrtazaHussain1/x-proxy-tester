/**
 * IP Rotation Service
 * 
 * This service handles automatic IP rotation for inactive proxies.
 * When a proxy becomes inactive in the portal, it automatically:
 * 1. Sends rotate IP or rotate unique IP command
 * 2. Waits for the rotation to complete
 * 3. Checks if proxy has become active
 * 4. Resumes testing if active
 * 
 * @module services/ip-rotation
 */

import { logger } from '../lib/logger';
import { prismaWithRetry as prisma } from '../lib/db';
import { config } from '../config';
import { rotateIp, rotateUniqueIp } from '../api/commands';
import { getDeviceById } from '../api/devices';
import { mapProxyStatusToActive } from './continuous-proxy-tester';
import type { Device } from '../types';

/**
 * Map to track devices that are currently being rotated
 * Prevents multiple simultaneous rotation attempts for the same device
 */
const rotationInProgress = new Map<string, Promise<boolean>>();

/**
 * Rotate IP for an inactive proxy and check if it becomes active
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

  // Create rotation promise
  const rotationPromise = (async (): Promise<boolean> => {
    try {
      logger.info(
        {
          deviceId,
          rotationType: useUniqueRotation ? 'unique' : 'standard',
        },
        '🔄 Starting IP rotation for inactive proxy'
      );

      // Send rotation command
      const commandResponse = useUniqueRotation
        ? await rotateUniqueIp(deviceId)
        : await rotateIp(deviceId);

      if (!commandResponse.success) {
        logger.warn(
          {
            deviceId,
            message: commandResponse.message,
            rotationType: useUniqueRotation ? 'unique' : 'standard',
          },
          'IP rotation command failed'
        );
        return false;
      }

      logger.info(
        {
          deviceId,
          message: commandResponse.message,
          rotationType: useUniqueRotation ? 'unique' : 'standard',
        },
        'IP rotation command sent successfully'
      );

      // Wait for rotation to complete (5 seconds as per requirement)
      const waitTime = config.ipRotation.waitAfterRotationMs;
      logger.debug(
        {
          deviceId,
          waitTimeMs: waitTime,
        },
        `Waiting ${waitTime}ms for IP rotation to complete`
      );

      await new Promise((resolve) => setTimeout(resolve, waitTime));

      // Check if proxy has become active
      try {
        const device = await getDeviceById(deviceId);
        const isActive = mapProxyStatusToActive(device.proxy_status);

        if (isActive) {
          logger.info(
            {
              deviceId,
              deviceName: device.name,
              proxyStatus: device.proxy_status,
            },
            '✅ Proxy became active after IP rotation'
          );

          // Update database active status
          await prisma.proxy.update({
            where: { deviceId },
            data: { active: true },
          });

          return true;
        } else {
          logger.warn(
            {
              deviceId,
              deviceName: device.name,
              proxyStatus: device.proxy_status,
            },
            'Proxy still inactive after IP rotation'
          );
          return false;
        }
      } catch (error) {
        logger.error(
          {
            deviceId,
            error: error instanceof Error ? error.message : 'Unknown error',
          },
          'Failed to check proxy status after rotation'
        );
        return false;
      }
    } catch (error) {
      logger.error(
        {
          deviceId,
          error: error instanceof Error ? error.message : 'Unknown error',
        },
        'Failed to rotate IP for inactive proxy'
      );
      return false;
    } finally {
      // Remove from rotation in progress map
      rotationInProgress.delete(deviceId);
    }
  })();

  // Store rotation promise
  rotationInProgress.set(deviceId, rotationPromise);

  return rotationPromise;
}

/**
 * Check for inactive proxies and attempt IP rotation
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

    // Check each inactive device
    const rotationPromises = inactiveDevices.map(async (device) => {
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
          'Failed to check/rotate inactive proxy'
        );
      }
    });

    await Promise.allSettled(rotationPromises);
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

