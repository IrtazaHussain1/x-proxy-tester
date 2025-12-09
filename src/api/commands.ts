/**
 * Commands API Module
 * Handles sending commands to XProxy Portal API for device actions.
 */

import { AxiosError } from 'axios';
import { getXProxyClient } from '../clients/xproxyClient';
import { COMMANDS_ENDPOINT } from './endpoints';
import { retryWithBackoff } from '../lib/circuit-breaker';
import { recordApiCall, recordApiError } from '../lib/metrics';
import { prismaWithRetry as prisma } from '../lib/db';
import { logger } from '../lib/logger';
import type { CommandResponse } from '../types';

/**
 * Send a command to a device via XProxy Portal API
 * 
 * @param deviceId - Device ID to send command to
 * @param action - Command action (e.g., 'airplane_mode_rotate', 'airplane_mode_rotate_unique')
 * @param params - Optional parameters for the command
 * @returns Command response from API
 * @throws Error if API call fails
 * 
 * @example
 * ```typescript
 * await sendCommand('device123', 'airplane_mode_rotate');
 * await sendCommand('device123', 'airplane_mode_rotate_unique');
 * ```
 */
export async function sendCommand(
  deviceId: string,
  action: string,
  params?: Record<string, any>
): Promise<CommandResponse> {
  const client = getXProxyClient();

  // Use retry with exponential backoff for resilience
  return retryWithBackoff(
    async () => {
      recordApiCall(); // Track API call metrics
      try {
        // Build command request payload (API expects snake_case: device_id)
        const commandRequest = {
          device_id: deviceId,
          action,
          ...(params && Object.keys(params).length > 0 ? params : {}),
        };

        // Send POST request to XProxy Portal API
        const response = await client.post<CommandResponse>(
          COMMANDS_ENDPOINT,
          commandRequest
        );

        return response.data;
      } catch (error) {
        recordApiError(); // Track API error metrics
        if (error instanceof AxiosError) {
          if (error.response) {
            throw new Error(
              `Command API error: ${error.response.status} - ${error.response.statusText}`
            );
          } else if (error.request) {
            throw new Error('Command API: No response received from server');
          } else {
            throw new Error(`Command API request error: ${error.message}`);
          }
        }
        throw error;
      }
    },
    {
      maxRetries: 3,
      initialDelay: 1000,
      maxDelay: 10000,
    }
  );
}

/**
 * Track manual rotation in database
 * This is called when /commands API endpoint is used to manually rotate IP
 * (as opposed to automatic rotation detected during testing)
 * 
 * @param deviceId - Device ID that was rotated via /commands API
 * @param isUnique - Whether it was a unique rotation command
 */
async function trackManualRotation(deviceId: string, isUnique: boolean = false): Promise<void> {
  try {
    await prisma.proxy.update({
      where: { deviceId },
      data: {
        lastManualRotationAt: new Date(),
        manualRotationCount: { increment: 1 },
        isManualRotation: true, // Flag that last rotation was via /commands API
      },
    });
    logger.info(
      {
        deviceId,
        rotationType: isUnique ? 'unique' : 'standard',
      },
      'Tracked manual IP rotation from /commands API'
    );
  } catch (error) {
    // Log error but don't throw - rotation command should still succeed
    logger.error(
      {
        deviceId,
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      'Failed to track manual rotation in database'
    );
  }
}

/**
 * Send rotate IP command to a device via /commands API
 * ALL calls to /commands API for rotation are tracked as manual rotation
 * 
 * @param deviceId - Device ID to rotate IP for
 * @returns Command response from API
 * @throws Error if API call fails
 */
export async function rotateIp(deviceId: string): Promise<CommandResponse> {
  const response = await sendCommand(deviceId, 'airplane_mode_rotate');
  
  // Track manual rotation - ALL /commands API calls for rotation are considered manual
  // This tracks how many times the /commands API rotation worked
  if (response.success) {
    await trackManualRotation(deviceId, false);
  }
  
  return response;
}

/**
 * Send rotate unique IP command to a device via /commands API
 * ALL calls to /commands API for rotation are tracked as manual rotation
 * 
 * @param deviceId - Device ID to rotate unique IP for
 * @returns Command response from API
 * @throws Error if API call fails
 */
export async function rotateUniqueIp(deviceId: string): Promise<CommandResponse> {
  const response = await sendCommand(deviceId, 'airplane_mode_rotate_unique');
  
  // Track manual rotation - ALL /commands API calls for rotation are considered manual
  // This tracks how many times the /commands API rotation worked
  if (response.success) {
    await trackManualRotation(deviceId, true);
  }
  
  return response;
}

