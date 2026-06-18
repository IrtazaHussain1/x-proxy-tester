import axios, { AxiosInstance, AxiosError, InternalAxiosRequestConfig } from 'axios';
import { CircuitBreaker, retryWithBackoff } from '../lib/circuit-breaker';
import { recordApiCall, recordApiError } from '../lib/metrics';
import { getToken, handleInvalidToken, isInvalidTokenError } from '../lib/auth-token-manager';
import { logger } from '../lib/logger';
import type { XProxyPhone, XProxyApiResponse } from '../types';

/**
 * Create XProxy API client instance
 * Uses token manager for authentication with automatic token refresh
 */
function createXProxyClient(): AxiosInstance {
  const rawBaseUrl = process.env.XPROXY_API_URL || 'https://jmui.vercel.app';
  const baseURL = rawBaseUrl.endsWith('/') ? rawBaseUrl : `${rawBaseUrl}/`;
  const timeout = parseInt(process.env.XPROXY_API_TIMEOUT_MS || '30000', 10);

  const client = axios.create({
    baseURL,
    timeout,
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
  });

  // Request interceptor: Add token to requests
  client.interceptors.request.use(
    async (config: InternalAxiosRequestConfig) => {
      try {
        const token = await getToken();
        if (token && config.headers) {
          config.headers.Authorization = `Bearer ${token}`;
        }
      } catch (error) {
        logger.error(
          { error: error instanceof Error ? error.message : 'Unknown error' },
          'Failed to get token for request'
        );
        // Continue without token, will fail and trigger refresh
      }
      return config;
    },
    (error) => {
      return Promise.reject(error);
    }
  );

  // Response interceptor: Handle 401 errors and refresh token
  client.interceptors.response.use(
    (response) => response,
    async (error: AxiosError) => {
      const originalRequest = error.config as InternalAxiosRequestConfig & { _retry?: boolean };

      // Check if this is an invalid token error and we haven't already retried
      if (isInvalidTokenError(error) && !originalRequest._retry) {
        originalRequest._retry = true; // Mark as retried to prevent infinite loop

        try {
          // Get a new token
          await handleInvalidToken(error);

          // Retry the original request with new token
          const token = await getToken();
          if (token && originalRequest.headers) {
            originalRequest.headers.Authorization = `Bearer ${token}`;
          }

          return client(originalRequest);
        } catch (refreshError) {
          logger.error(
            { error: refreshError instanceof Error ? refreshError.message : 'Unknown error' },
            'Failed to refresh token, cannot retry request'
          );
          return Promise.reject(refreshError);
        }
      }

      return Promise.reject(error);
    }
  );

  return client;
}

// Create singleton client instance
const xproxyClient = createXProxyClient();

// Create circuit breaker for API calls
const apiCircuitBreaker = new CircuitBreaker('xproxy-api', {
  failureThreshold: 5,
  resetTimeout: 60000, // 1 minute
  monitoringPeriod: 60000, // 1 minute
});

/**
 * Fetch all proxies from XProxy Portal API
 * @returns Array of proxy phone objects
 * @throws Error if API call fails or response format is invalid
 */
export async function fetchProxies(): Promise<XProxyPhone[]> {
  const endpoint = process.env.XPROXY_API_ENDPOINT || '/api/devices';

  return apiCircuitBreaker.execute(async () => {
    return retryWithBackoff(
      async () => {
        recordApiCall();
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
          recordApiError();
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
      },
      {
        maxRetries: 3,
        initialDelay: 1000,
        maxDelay: 10000,
      }
    );
  });
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
