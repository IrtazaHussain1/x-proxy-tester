import { AxiosError } from 'axios';
import { getXProxyClient } from '../clients/xproxyClient';
import { DEVICES_ENDPOINT } from './endpoints';
import { retryWithBackoff } from '../lib/circuit-breaker';
import { recordApiCall, recordApiError } from '../lib/metrics';
import { isInvalidTokenError, handleInvalidToken } from '../lib/auth-token-manager';
import { logger } from '../lib/logger';
import type { Device, DevicesResponse } from '../types';

export interface GetDevicesParams {
  offset?: number;
  limit?: number;
  total_count?: boolean;
  count_by_status?: boolean;
  search?: string;
  locations?: string;
  status?: 'active' | 'inactive';
}

/**
 * Get devices with pagination and filtering
 * @param params - Query parameters for pagination and filtering
 * @returns Array of device objects
 */
export async function getDevices(params?: GetDevicesParams): Promise<Device[]> {
  const client = getXProxyClient();

  return retryWithBackoff(
    async () => {
      recordApiCall();
      try {
        const response = await client.get<DevicesResponse>(DEVICES_ENDPOINT, {
          params,
        });

        // Extract devices from response.data.data.devices
        if (response.data?.data?.devices && Array.isArray(response.data.data.devices)) {
          return response.data.data.devices;
        }

        // Fallback for different response structures
        const devices =
          (response.data as any).devices ||
          (response.data as any).data?.devices ||
          (Array.isArray(response.data) ? response.data : []);

        if (!Array.isArray(devices)) {
          throw new Error('Invalid API response format: expected devices array');
        }

        return devices;
      } catch (error) {
        recordApiError();
        if (error instanceof AxiosError) {
          if (error.response) {
            throw new Error(
              `Devices API error: ${error.response.status} - ${error.response.statusText}`
            );
          } else if (error.request) {
            throw new Error('Devices API: No response received from server');
          } else {
            throw new Error(`Devices API request error: ${error.message}`);
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
 * Get devices with metadata (total, active, inactive counts)
 * @param params - Query parameters for pagination and filtering
 * @returns Full devices response with metadata
 */
export async function getDevicesWithMetadata(
  params?: GetDevicesParams
): Promise<DevicesResponse['data']> {
  const client = getXProxyClient();

  return retryWithBackoff(
    async () => {
      recordApiCall();
      try {
        const response = await client.get<DevicesResponse>(DEVICES_ENDPOINT, {
          params: {
            ...params,
            total_count: true,
            count_by_status: true,
          },
        });

        if (response.data?.data) {
          return response.data.data;
        }

        throw new Error('Invalid API response format: expected data object');
      } catch (error) {
        recordApiError();
        
        // Handle invalid token errors
        if (isInvalidTokenError(error)) {
          logger.warn('Invalid token detected in devices metadata API, refreshing token');
          try {
            await handleInvalidToken(error);
            // Retry the request once after token refresh
            const response = await client.get<DevicesResponse>(DEVICES_ENDPOINT, {
              params: {
                ...params,
                total_count: true,
                count_by_status: true,
              },
            });
            
            if (response.data?.data) {
              return response.data.data;
            }
            
            throw new Error('Invalid API response format: expected data object');
          } catch (retryError) {
            logger.error(
              { error: retryError instanceof Error ? retryError.message : 'Unknown error' },
              'Retry after token refresh failed'
            );
          }
        }
        
        if (error instanceof AxiosError) {
          if (error.response) {
            throw new Error(
              `Devices API error: ${error.response.status} - ${error.response.statusText}`
            );
          } else if (error.request) {
            throw new Error('Devices API: No response received from server');
          } else {
            throw new Error(`Devices API request error: ${error.message}`);
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
 * Get a specific device by ID
 * @param deviceId - Device ID
 * @returns Device object
 */
export async function getDeviceById(deviceId: string | number): Promise<Device> {
  const client = getXProxyClient();

  return retryWithBackoff(
    async () => {
      recordApiCall();
      try {
        const response = await client.get<any>(`${DEVICES_ENDPOINT}/${deviceId}`);
        
        // Handle wrapped response structure: { success: true, data: {...} }
        if (response.data?.data && typeof response.data.data === 'object') {
          return response.data.data as Device;
        }
        
        // Fallback: assume response.data is the device directly
        return response.data as Device;
      } catch (error) {
        recordApiError();
        
        // Handle invalid token errors
        if (isInvalidTokenError(error)) {
          logger.warn('Invalid token detected in device by ID API, refreshing token');
          try {
            await handleInvalidToken(error);
            // Retry the request once after token refresh
            const response = await client.get<any>(`${DEVICES_ENDPOINT}/${deviceId}`);
            
            // Handle wrapped response structure: { success: true, data: {...} }
            if (response.data?.data && typeof response.data.data === 'object') {
              return response.data.data as Device;
            }
            
            // Fallback: assume response.data is the device directly
            return response.data as Device;
          } catch (retryError) {
            logger.error(
              { error: retryError instanceof Error ? retryError.message : 'Unknown error' },
              'Retry after token refresh failed'
            );
          }
        }
        
        if (error instanceof AxiosError) {
          if (error.response) {
            throw new Error(
              `Device API error: ${error.response.status} - ${error.response.statusText}`
            );
          } else if (error.request) {
            throw new Error('Device API: No response received from server');
          } else {
            throw new Error(`Device API request error: ${error.message}`);
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

