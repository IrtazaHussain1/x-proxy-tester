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
  autoDeactivation: {
    enabled: boolean;
    consecutiveFailureThreshold: number;
    failureRateThreshold: number;
    failureRateWindowSize: number;
  };
  autoRecovery: {
    enabled: boolean;
    checkIntervalMs: number;
    consecutiveSuccessThreshold: number;
  };
  ipRotation: {
    enabled: boolean;
    checkIntervalMs: number;
    waitAfterRotationMs: number;
    rotationCooldownMs: number;
    preferUniqueRotation: boolean;
    periodicRotationIntervalMs: number;
  };
  ipRotationTesting: {
    enabled: boolean;
    rotationIntervalMs: number;
    waitAfterRotationMs: number;
    testConcurrency: number;
    batchSize: number;
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

  // Auto-deactivation configuration
  const autoDeactivationEnabled = process.env.AUTO_DEACTIVATION_ENABLED !== 'false'; // Default: true
  const consecutiveFailureThreshold = parseInt(
    process.env.AUTO_DEACTIVATION_CONSECUTIVE_FAILURES || '20',
    10
  );
  const failureRateThreshold = parseFloat(
    process.env.AUTO_DEACTIVATION_FAILURE_RATE || '0.9'
  ); // 90% failure rate
  const failureRateWindowSize = parseInt(
    process.env.AUTO_DEACTIVATION_FAILURE_RATE_WINDOW || '50',
    10
  ); // Last 50 requests

  // Auto-recovery configuration
  const autoRecoveryEnabled = process.env.AUTO_RECOVERY_ENABLED !== 'false'; // Default: true
  const recoveryCheckIntervalMs = parseInt(
    process.env.AUTO_RECOVERY_CHECK_INTERVAL_MS || '300000',
    10
  ); // 5 minutes default
  const consecutiveSuccessThreshold = parseInt(
    process.env.AUTO_RECOVERY_CONSECUTIVE_SUCCESSES || '5',
    10
  );

  // IP rotation configuration
  const ipRotationEnabled = process.env.IP_ROTATION_ENABLED !== 'false'; // Default: true
  const ipRotationCheckIntervalMs = parseInt(
    process.env.IP_ROTATION_CHECK_INTERVAL_MS || '60000',
    10
  ); // 1 minute default
  const waitAfterRotationMs = parseInt(
    process.env.IP_ROTATION_WAIT_AFTER_ROTATION_MS || '5000',
    10
  ); // 5 seconds as per requirement
  const rotationCooldownMs = parseInt(
    process.env.IP_ROTATION_COOLDOWN_MS || '300000',
    10
  ); // 5 minutes cooldown between rotation attempts
  const preferUniqueRotation = process.env.IP_ROTATION_PREFER_UNIQUE === 'true'; // Default: false
  const periodicRotationIntervalMs = parseInt(
    process.env.PERIODIC_IP_ROTATION_INTERVAL_MS || '600000',
    10
  ); // 10 minutes (600000ms) default for periodic rotation

  // IP rotation testing configuration
  const ipRotationTestingEnabled = process.env.IP_ROTATION_TESTING_ENABLED !== 'false'; // Default: true
  const ipRotationTestingIntervalMs = parseInt(
    process.env.IP_ROTATION_TESTING_INTERVAL_MS || '600000',
    10
  ); // 10 minutes default
  const ipRotationTestingWaitAfterRotationMs = parseInt(
    process.env.IP_ROTATION_TESTING_WAIT_AFTER_ROTATION_MS || '5000',
    10
  ); // 5 seconds default
  const ipRotationTestingConcurrency = parseInt(
    process.env.IP_ROTATION_TESTING_CONCURRENCY || '20',
    10
  ); // 20 concurrent operations default (for 4GB/2vCPU)
  const ipRotationTestingBatchSize = parseInt(
    process.env.IP_ROTATION_TESTING_BATCH_SIZE || '50',
    10
  ); // 50 proxies per batch default

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
  if (consecutiveFailureThreshold < 1) {
    throw new Error('AUTO_DEACTIVATION_CONSECUTIVE_FAILURES must be at least 1');
  }
  if (failureRateThreshold < 0 || failureRateThreshold > 1) {
    throw new Error('AUTO_DEACTIVATION_FAILURE_RATE must be between 0 and 1');
  }
  if (failureRateWindowSize < 1) {
    throw new Error('AUTO_DEACTIVATION_FAILURE_RATE_WINDOW must be at least 1');
  }
  if (recoveryCheckIntervalMs < 1000) {
    throw new Error('AUTO_RECOVERY_CHECK_INTERVAL_MS must be at least 1000ms');
  }
  if (consecutiveSuccessThreshold < 1) {
    throw new Error('AUTO_RECOVERY_CONSECUTIVE_SUCCESSES must be at least 1');
  }
  if (ipRotationCheckIntervalMs < 1000) {
    throw new Error('IP_ROTATION_CHECK_INTERVAL_MS must be at least 1000ms');
  }
  if (waitAfterRotationMs < 1000) {
    throw new Error('IP_ROTATION_WAIT_AFTER_ROTATION_MS must be at least 1000ms');
  }
  if (rotationCooldownMs < 0) {
    throw new Error('IP_ROTATION_COOLDOWN_MS must be at least 0');
  }
  if (periodicRotationIntervalMs < 1000) {
    throw new Error('PERIODIC_IP_ROTATION_INTERVAL_MS must be at least 1000ms (1 second)');
  }
  if (ipRotationTestingIntervalMs < 60000) {
    throw new Error('IP_ROTATION_TESTING_INTERVAL_MS must be at least 60000ms (1 minute)');
  }
  if (ipRotationTestingWaitAfterRotationMs < 1000) {
    throw new Error('IP_ROTATION_TESTING_WAIT_AFTER_ROTATION_MS must be at least 1000ms');
  }
  if (ipRotationTestingConcurrency < 1) {
    throw new Error('IP_ROTATION_TESTING_CONCURRENCY must be at least 1');
  }
  if (ipRotationTestingBatchSize < 1) {
    throw new Error('IP_ROTATION_TESTING_BATCH_SIZE must be at least 1');
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
    autoDeactivation: {
      enabled: autoDeactivationEnabled,
      consecutiveFailureThreshold,
      failureRateThreshold,
      failureRateWindowSize,
    },
    autoRecovery: {
      enabled: autoRecoveryEnabled,
      checkIntervalMs: recoveryCheckIntervalMs,
      consecutiveSuccessThreshold,
    },
    ipRotation: {
      enabled: ipRotationEnabled,
      checkIntervalMs: ipRotationCheckIntervalMs,
      waitAfterRotationMs,
      rotationCooldownMs,
      preferUniqueRotation,
      periodicRotationIntervalMs,
    },
    ipRotationTesting: {
      enabled: ipRotationTestingEnabled,
      rotationIntervalMs: ipRotationTestingIntervalMs,
      waitAfterRotationMs: ipRotationTestingWaitAfterRotationMs,
      testConcurrency: ipRotationTestingConcurrency,
      batchSize: ipRotationTestingBatchSize,
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

