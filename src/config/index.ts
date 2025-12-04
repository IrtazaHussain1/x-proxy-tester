/**
 * Configuration Management Module
 * 
 * Centralized configuration with validation and type safety.
 * All environment variables are validated on startup and exposed through
 * a typed configuration object.
 * 
 * @module config
 */

/**
 * Application configuration interface
 * 
 * All configuration values are validated and typed.
 * Missing required variables will throw an error on startup.
 */
interface Config {
  database: {
    url: string;
  };
  xproxy: {
    apiUrl: string;
    apiEndpoint: string;
    apiToken: string;
    timeoutMs: number;
  };
  testing: {
    targetUrl: string;
    intervalMs: number;
    requestTimeoutMs: number;
    rotationThreshold: number;
  };
  refresh: {
    intervalMs: number;
  };
  stability: {
    checkIntervalMs: number;
  };
  runtime: {
    minRunHours: number;
    runMode: 'infinite' | 'fixed';
    monitorCheckIntervalMs: number;
  };
  logging: {
    level: string;
  };
}

/**
 * Validates and parses environment variables into typed configuration
 * 
 * Performs validation:
 * - Checks for required environment variables
 * - Validates numeric values (min thresholds)
 * - Provides sensible defaults where appropriate
 * 
 * @returns Validated configuration object
 * @throws Error if required variables are missing or invalid
 * 
 * @example
 * ```typescript
 * // Throws if DATABASE_URL is missing
 * const config = validateConfig();
 * ```
 */
function validateConfig(): Config {
  const requiredEnvVars = [
    'DATABASE_URL',
    'XPROXY_API_URL',
    'XPROXY_API_TOKEN',
  ];

  const missing = requiredEnvVars.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  const testIntervalMs = parseInt(process.env.TEST_INTERVAL_MS || '5000', 10);
  const requestTimeoutMs = parseInt(process.env.REQUEST_TIMEOUT_MS || '30000', 10);
  const rotationThreshold = parseInt(process.env.ROTATION_THRESHOLD || '10', 10);
  const proxyRefreshIntervalMs = parseInt(
    process.env.PROXY_REFRESH_INTERVAL_MS || '21600000',
    10
  );
  const stabilityCheckIntervalMs = parseInt(
    process.env.STABILITY_CHECK_INTERVAL_MS || '600000',
    10
  );
  const minRunHours = parseInt(process.env.MIN_RUN_HOURS || '72', 10);
  const runMode = (process.env.RUN_MODE || 'infinite') as 'infinite' | 'fixed';
  const monitorCheckIntervalMs = parseInt(
    process.env.MONITOR_CHECK_INTERVAL_MS || '3600000',
    10
  ); // 1 hour default

  // Validation
  if (testIntervalMs < 1000) {
    throw new Error('TEST_INTERVAL_MS must be at least 1000ms (1 second)');
  }
  if (requestTimeoutMs < 1000) {
    throw new Error('REQUEST_TIMEOUT_MS must be at least 1000ms (1 second)');
  }
  if (rotationThreshold < 1) {
    throw new Error('ROTATION_THRESHOLD must be at least 1');
  }
  if (minRunHours < 1) {
    throw new Error('MIN_RUN_HOURS must be at least 1');
  }
  if (runMode !== 'infinite' && runMode !== 'fixed') {
    throw new Error('RUN_MODE must be either "infinite" or "fixed"');
  }

  return {
    database: {
      url: process.env.DATABASE_URL!,
    },
    xproxy: {
      apiUrl: process.env.XPROXY_API_URL!,
      apiEndpoint: process.env.XPROXY_API_ENDPOINT || '/api/phones',
      apiToken: process.env.XPROXY_API_TOKEN!,
      timeoutMs: parseInt(process.env.XPROXY_API_TIMEOUT_MS || '30000', 10),
    },
    testing: {
      targetUrl: process.env.TEST_TARGET_URL || 'https://api.ipify.org?format=json',
      intervalMs: testIntervalMs,
      requestTimeoutMs,
      rotationThreshold,
    },
    refresh: {
      intervalMs: proxyRefreshIntervalMs,
    },
    stability: {
      checkIntervalMs: stabilityCheckIntervalMs,
    },
    runtime: {
      minRunHours,
      runMode,
      monitorCheckIntervalMs,
    },
    logging: {
      level: process.env.LOG_LEVEL || 'info',
    },
  };
}

export const config = validateConfig();

