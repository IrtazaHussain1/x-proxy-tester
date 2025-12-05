/**
 * Commands API Module
 * 
 * Handles sending commands to XProxy Portal API for device actions
 * such as IP rotation.
 * 
 * @module api/commands
 */

import { AxiosError } from 'axios';
import { getXProxyClient } from '../clients/xproxyClient';
import { COMMANDS_ENDPOINT } from './endpoints';
import { retryWithBackoff } from '../lib/circuit-breaker';
import { recordApiCall, recordApiError } from '../lib/metrics';
import type { CommandRequest, CommandResponse } from '../types';

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

  return retryWithBackoff(
    async () => {
      recordApiCall();
      try {
        const commandRequest: CommandRequest = {
          deviceId,
          action,
          params,
        };

        const response = await client.post<CommandResponse>(
          COMMANDS_ENDPOINT,
          commandRequest
        );

        return response.data;
      } catch (error) {
        recordApiError();
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
 * Send rotate IP command to a device
 * 
 * @param deviceId - Device ID to rotate IP for
 * @returns Command response from API
 * @throws Error if API call fails
 */
export async function rotateIp(deviceId: string): Promise<CommandResponse> {
  return sendCommand(deviceId, 'airplane_mode_rotate');
}

/**
 * Send rotate unique IP command to a device
 * 
 * @param deviceId - Device ID to rotate unique IP for
 * @returns Command response from API
 * @throws Error if API call fails
 */
export async function rotateUniqueIp(deviceId: string): Promise<CommandResponse> {
  return sendCommand(deviceId, 'airplane_mode_rotate_unique');
}

