/**
 * Commands API Module
 * Handles sending commands to XProxy Portal API for device actions.
 */

import { AxiosError } from 'axios';
import { getXProxyClient } from '../clients/xproxyClient';
import { COMMANDS_ENDPOINT } from './endpoints';
import { retryWithBackoff } from '../lib/circuit-breaker';
import { recordApiCall, recordApiError } from '../lib/metrics';
import type { CommandResponse } from '../types';

/**
 * Optional retry configuration for command-API calls.
 *
 * Useful for high-volume callers (e.g. periodic rotation cycle on thousands
 * of devices) where the default 3 retries × exponential backoff per failure
 * dominates total cycle time. Defaults preserve the original behavior.
 */
export interface CommandRetryOptions {
  maxRetries?: number;
  initialDelay?: number;
  maxDelay?: number;
}

const DEFAULT_COMMAND_RETRY_OPTIONS: Required<CommandRetryOptions> = {
  maxRetries: 3,
  initialDelay: 1000,
  maxDelay: 10000,
};

/**
 * Send a command to a device via XProxy Portal API
 * 
 * @param deviceId - Device ID to send command to
 * @param action - Command action (e.g., 'airplane_mode_rotate', 'airplane_mode_rotate_unique')
 * @param params - Optional parameters for the command
 * @param retryOptions - Optional retry/backoff overrides (defaults: 3 retries, 1s→10s)
 * @returns Command response from API
 * @throws Error if API call fails
 * 
 * @example
 * ```typescript
 * await sendCommand('device123', 'airplane_mode_rotate');
 * await sendCommand('device123', 'airplane_mode_rotate_unique');
 * await sendCommand('device123', 'airplane_mode_rotate', undefined, { maxRetries: 1 });
 * ```
 */
export async function sendCommand(
  deviceId: string,
  action: string,
  params?: Record<string, any>,
  retryOptions?: CommandRetryOptions
): Promise<CommandResponse> {
  const client = getXProxyClient();

  // Merge caller overrides over defaults so existing call sites are unaffected.
  const resolvedRetryOptions = {
    ...DEFAULT_COMMAND_RETRY_OPTIONS,
    ...(retryOptions || {}),
  };

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
    resolvedRetryOptions
  );
}

/**
 * Send rotate IP command to a device
 * 
 * @param deviceId - Device ID to rotate IP for
 * @param retryOptions - Optional retry/backoff overrides (defaults: 3 retries, 1s→10s)
 * @returns Command response from API
 * @throws Error if API call fails
 */
export async function rotateIp(
  deviceId: string,
  retryOptions?: CommandRetryOptions
): Promise<CommandResponse> {
  return sendCommand(deviceId, 'airplane_mode_rotate', undefined, retryOptions);
}

/**
 * Send rotate unique IP command to a device
 * 
 * @param deviceId - Device ID to rotate unique IP for
 * @param retryOptions - Optional retry/backoff overrides (defaults: 3 retries, 1s→10s)
 * @returns Command response from API
 * @throws Error if API call fails
 */
export async function rotateUniqueIp(
  deviceId: string,
  retryOptions?: CommandRetryOptions
): Promise<CommandResponse> {
  return sendCommand(deviceId, 'airplane_mode_rotate_unique', undefined, retryOptions);
}

