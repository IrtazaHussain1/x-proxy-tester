/**
 * IP Rotation Worker Thread
 * 
 * This module runs IP rotation logic in a separate worker thread to avoid
 * blocking the main event loop. The worker handles:
 * - Checking for inactive proxies
 * - Sending rotation commands
 * - Waiting for rotation to complete
 * - Checking if proxy became active
 * 
 * @module services/ip-rotation-worker
 */

import { parentPort } from 'worker_threads';
import { logger } from '../lib/logger';
import { prismaWithRetry as prisma } from '../lib/db';
import { rotateIp, rotateUniqueIp } from '../api/commands';
import { getDeviceById } from '../api/devices';

/**
 * Map proxy status to active boolean
 */
function mapProxyStatusToActive(proxyStatus: string | undefined | null): boolean {
  if (!proxyStatus) {
    return false;
  }
  const normalizedStatus = proxyStatus.toLowerCase().trim();
  return normalizedStatus === 'active';
}

/**
 * Rotate IP for an inactive proxy and check if it becomes active
 * 
 * @param deviceId - Device ID to rotate IP for
 * @param useUniqueRotation - Whether to use unique IP rotation (default: false)
 * @param waitAfterRotationMs - Time to wait after rotation command (default: 5000)
 * @returns Promise resolving to true if proxy became active, false otherwise
 */
async function rotateIpForInactiveProxy(
  deviceId: string,
  useUniqueRotation: boolean = false,
  waitAfterRotationMs: number = 5000
): Promise<boolean> {
  try {
    logger.info(
      {
        deviceId,
        rotationType: useUniqueRotation ? 'unique' : 'standard',
      },
      '🔄 Starting IP rotation for inactive proxy (worker thread)'
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

    // Wait for rotation to complete
    logger.debug(
      {
        deviceId,
        waitTimeMs: waitAfterRotationMs,
      },
      `Waiting ${waitAfterRotationMs}ms for IP rotation to complete`
    );

    await new Promise((resolve) => setTimeout(resolve, waitAfterRotationMs));

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
  }
}

/**
 * Handle messages from parent thread
 */
if (parentPort) {
  parentPort.on('message', async (message: {
    type: string;
    deviceId: string;
    useUniqueRotation?: boolean;
    waitAfterRotationMs?: number;
  }) => {
    if (message.type === 'rotate') {
      try {
        const result = await rotateIpForInactiveProxy(
          message.deviceId,
          message.useUniqueRotation ?? false,
          message.waitAfterRotationMs ?? 5000
        );

        // Send result back to parent
        parentPort?.postMessage({
          type: 'rotation-complete',
          deviceId: message.deviceId,
          success: result,
        });
      } catch (error) {
        parentPort?.postMessage({
          type: 'rotation-error',
          deviceId: message.deviceId,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }
  });
}

