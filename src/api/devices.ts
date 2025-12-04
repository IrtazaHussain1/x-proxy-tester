import { AxiosError } from 'axios';
import { getXProxyClient } from '../clients/xproxyClient';
import { DEVICES_ENDPOINT } from './endpoints';
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
}

/**
 * Get a specific device by ID
 * @param deviceId - Device ID
 * @returns Device object
 */
export async function getDeviceById(deviceId: string | number): Promise<Device> {
  const client = getXProxyClient();

  try {
    const response = await client.get<Device>(`${DEVICES_ENDPOINT}/${deviceId}`);
    return response.data;
  } catch (error) {
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
}

