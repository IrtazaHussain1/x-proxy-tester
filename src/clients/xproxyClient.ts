import axios, { AxiosInstance, AxiosError } from 'axios';
import type { XProxyPhone, XProxyApiResponse } from '../types';

/**
 * Create XProxy API client instance
 * Uses environment variables for configuration
 */
function createXProxyClient(): AxiosInstance {
  const baseURL = process.env.XPROXY_API_URL || 'https://jmui.vercel.app';
  const token = process.env.XPROXY_API_TOKEN;
  const timeout = parseInt(process.env.XPROXY_API_TIMEOUT_MS || '30000', 10);

  if (!token) {
    throw new Error('XPROXY_API_TOKEN is required in environment variables');
  }

  return axios.create({
    baseURL,
    timeout,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
  });
}

// Create singleton client instance
const xproxyClient = createXProxyClient();

/**
 * Fetch all proxies from XProxy Portal API
 * @returns Array of proxy phone objects
 * @throws Error if API call fails or response format is invalid
 */
export async function fetchProxies(): Promise<XProxyPhone[]> {
  const endpoint = process.env.XPROXY_API_ENDPOINT || '/api/phones';

  try {
    const response = await xproxyClient.get<XProxyApiResponse>(endpoint);

    // Handle different response structures
    const phones =
      response.data.phones ||
      response.data.data ||
      (Array.isArray(response.data) ? response.data : []);

    if (!Array.isArray(phones)) {
      throw new Error('Invalid API response format: expected array of phones');
    }

    return phones;
  } catch (error) {
    if (error instanceof AxiosError) {
      if (error.response) {
        // Server responded with error status
        throw new Error(
          `XProxy API error: ${error.response.status} - ${error.response.statusText}`
        );
      } else if (error.request) {
        // Request made but no response
        throw new Error('XProxy API: No response received from server');
      } else {
        // Error setting up request
        throw new Error(`XProxy API request error: ${error.message}`);
      }
    }
    throw error;
  }
}

/**
 * Get the full API URL (base URL + endpoint)
 * @returns Full API URL string
 */
export function getXProxyApiUrl(endpoint = '/'): string {
  const baseURL = process.env.XPROXY_API_URL || 'https://jmui.vercel.app';
  return `${baseURL}${endpoint}`;
}

/**
 * Get client instance (for advanced usage)
 * @returns Axios instance configured for XProxy API
 */
export function getXProxyClient(): AxiosInstance {
  return xproxyClient;
}
