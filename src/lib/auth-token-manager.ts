/**
 * Authentication Token Manager
 * 
 * Singleton module that manages authentication tokens for the XProxy API.
 * Handles automatic token refresh on 401 errors and provides a centralized
 * token storage mechanism.
 * 
 * @module lib/auth-token-manager
 */

import axios, { AxiosError } from 'axios';
import { logger } from './logger';

/**
 * Login response structure
 */
interface LoginResponse {
  success: boolean;
  data?: {
    token: string;
  };
  error?: {
    message: string;
  };
}

/**
 * Module-level state (singleton pattern)
 */
let currentToken: string | null = null;
let loginPromise: Promise<string> | null = null; // Prevent concurrent login attempts
let isLoggingIn = false;

/**
 * Login credentials from environment
 */
function getLoginCredentials(): { email: string; password: string; loginUrl: string } {
  const email = process.env.XPROXY_LOGIN_EMAIL;
  const password = process.env.XPROXY_LOGIN_PASSWORD;
  const loginUrl = process.env.XPROXY_LOGIN_URL || 'https://proxyapi.jumpermedia.co/v2/auth/login';

  if (!email || !password) {
    throw new Error('XPROXY_LOGIN_EMAIL and XPROXY_LOGIN_PASSWORD are required in environment variables');
  }

  return { email, password, loginUrl };
}

/**
 * Performs login to get a new authentication token
 * 
 * @returns Promise resolving to the authentication token
 * @throws Error if login fails
 */
async function performLogin(): Promise<string> {
  // If already logging in, wait for that promise
  if (loginPromise) {
    logger.debug('Login already in progress, waiting for existing login attempt');
    return loginPromise;
  }

  // Prevent concurrent login attempts
  if (isLoggingIn) {
    // Wait a bit and retry
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (loginPromise) {
      return loginPromise;
    }
  }

  isLoggingIn = true;
  loginPromise = (async () => {
    try {
      const { email, password, loginUrl } = getLoginCredentials();

      logger.info({ loginUrl, email }, 'Performing login to get authentication token');

      const response = await axios.post<LoginResponse>(
        loginUrl,
        { email, password },
        {
          headers: {
            'Accept': '*/*',
            'Accept-Language': 'en-US,en;q=0.9',
            'Connection': 'keep-alive',
            'Content-Type': 'application/json',
            'Origin': 'https://jmui.vercel.app',
            'Referer': 'https://jmui.vercel.app/',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36',
          },
          timeout: 30000, // 30 seconds timeout
        }
      );

      if (!response.data.success || !response.data.data?.token) {
        const errorMessage = response.data.error?.message || 'Login failed: Invalid response';
        logger.error({ error: errorMessage }, 'Login failed');
        throw new Error(errorMessage);
      }

      const token = response.data.data.token;
      currentToken = token;

      logger.info('Login successful, token obtained');

      return token;
    } catch (error) {
      const errorMessage = error instanceof AxiosError
        ? error.response?.data?.error?.message || error.message
        : error instanceof Error
        ? error.message
        : 'Unknown error';

      logger.error(
        {
          error: errorMessage,
          statusCode: error instanceof AxiosError ? error.response?.status : undefined,
        },
        'Failed to login'
      );

      // Clear token on login failure
      currentToken = null;
      throw new Error(`Login failed: ${errorMessage}`);
    } finally {
      isLoggingIn = false;
      loginPromise = null;
    }
  })();

  return loginPromise;
}

/**
 * Gets the current authentication token
 * If no token exists, performs login to get a new one
 * 
 * @returns Promise resolving to the current authentication token
 */
export async function getToken(): Promise<string> {
  // If we have a cached token, use it
  if (currentToken) {
    return currentToken;
  }

  // No token, need to login
  return performLogin();
}

/**
 * Forces a new login to refresh the token
 * Useful when token is known to be invalid
 * 
 * @returns Promise resolving to the new authentication token
 */
export async function refreshToken(): Promise<string> {
  logger.info('Forcing token refresh');
  currentToken = null; // Clear current token
  return performLogin();
}

/**
 * Clears the current token (forces re-login on next request)
 */
export function clearToken(): void {
  logger.debug('Clearing authentication token');
  currentToken = null;
}

/**
 * Checks if a response indicates an invalid token error
 * 
 * @param error - Axios error to check
 * @returns True if error indicates invalid token
 */
export function isInvalidTokenError(error: unknown): boolean {
  if (!(error instanceof AxiosError)) {
    return false;
  }

  // Check for 401 status
  if (error.response?.status === 401) {
    return true;
  }

  // Check response body for invalid token message
  const responseData = error.response?.data;
  if (responseData && typeof responseData === 'object') {
    const errorMessage = (responseData as any).error?.message || (responseData as any).message || '';
    if (
      typeof errorMessage === 'string' &&
      (errorMessage.toLowerCase().includes('invalid token') ||
        errorMessage.toLowerCase().includes('unauthorized') ||
        errorMessage.toLowerCase().includes('token expired'))
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Handles an invalid token error by refreshing the token
 * 
 * @param error - Axios error that indicates invalid token
 * @returns Promise resolving to the new token
 */
export async function handleInvalidToken(error: unknown): Promise<string> {
  if (!isInvalidTokenError(error)) {
    throw error; // Not an invalid token error, re-throw
  }

  logger.warn('Invalid token detected, refreshing authentication token');

  // Clear current token and get a new one
  currentToken = null;
  return refreshToken();
}

