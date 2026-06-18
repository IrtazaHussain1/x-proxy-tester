import 'dotenv/config';

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
    /** Max concurrent prisma.proxy.update calls when syncing portal → DB (prevents pool exhaustion). */
    proxySyncConcurrency: number;
  };
  xproxy: {
    apiUrl: string;
    apiEndpoint: string;
    loginUrl: string;
    loginEmail: string;
    loginPassword: string;
    timeoutMs: number;
  };
  testing: {
    testInactiveProxies: boolean;
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
    /**
     * Concurrency for sending rotation commands during a cycle.
     * Independent from `database.proxySyncConcurrency` because command sending
     * is API-bound, not Prisma-pool-bound. Default: 50.
     */
    commandConcurrency: number;
    /**
     * Max retries for the rotateIp/rotateUniqueIp HTTP call inside a periodic
     * rotation cycle. Periodic cycles run repeatedly, so aggressive retrying
     * just inflates cycle time. Default: 1.
     */
    periodicCommandMaxRetries: number;
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
  speedTest: {
    enabled: boolean;
    intervalMs: number;
    targetUrl: string;
    uploadTargetUrl: string;
    timeoutMs: number;
    maxConcurrentTests: number;
  };
  logging: {
    level: string;
  };
  rotationTracking: {
    verificationWaitTimeMs: number;
    maxVerificationAttempts: number;
    verificationTimeoutMs: number;
  };
  duplicateIpSnapshot: {
    enabled: boolean;
    intervalMs: number;
    retentionDays: number;
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
    'XPROXY_LOGIN_EMAIL',
    'XPROXY_LOGIN_PASSWORD',
  ];

  const missing = requiredEnvVars.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  // Security warnings — logged at startup; not hard failures to allow local dev
  const redisPassword = process.env.REDIS_PASSWORD;
  if (!redisPassword || redisPassword.trim() === '') {
    console.warn('WARNING: REDIS_PASSWORD not set. BullMQ job payloads may contain device credentials. Set a strong password in production.');
  }

  if (process.env.NODE_ENV === 'production') {
    const encKey = process.env.ENCRYPTION_KEY;
    const defaultKey = 'x-proxy-tester-default-key-change-in-production';
    if (!encKey || encKey === defaultKey) {
      throw new Error('ENCRYPTION_KEY must be set to a unique value in production. Run: node -e "require(\'crypto\').randomBytes(32).toString(\'hex\')" to generate one.');
    }
  }

  const testIntervalMs = parseInt(process.env.TEST_INTERVAL_MS || '5000', 10);
  const requestTimeoutMs = parseInt(process.env.REQUEST_TIMEOUT_MS || '30000', 10);
  const rotationThreshold = parseInt(process.env.ROTATION_THRESHOLD || '10', 10);
  const proxyRefreshIntervalMs = parseInt(
    process.env.PROXY_REFRESH_INTERVAL_MS || '3600000',
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

  // Concurrency for sending rotation commands. Higher than proxySyncConcurrency
  // because command sending is API-bound, not DB-bound.
  const rotationCommandConcurrency = parseInt(
    process.env.ROTATION_COMMAND_CONCURRENCY || '50',
    10
  );

  // Retries on rotateIp/rotateUniqueIp inside periodic cycles.
  // Default 1 (fast-fail) — failed devices will simply be retried on the next cycle.
  const periodicRotationCommandMaxRetries = parseInt(
    process.env.PERIODIC_ROTATION_COMMAND_MAX_RETRIES || '1',
    10
  );

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

  // Speed test configuration
  const speedTestEnabled = process.env.SPEED_TEST_ENABLED !== 'false';
  const speedTestIntervalMs = parseInt(process.env.SPEED_TEST_INTERVAL_MS || '3600000', 10); // 1 hour default
  const speedTestTargetUrl = process.env.SPEED_TEST_TARGET_URL || 'https://speed.cloudflare.com/__down?bytes=1048576'; // 1MB chunk
  const speedTestUploadTargetUrl = process.env.SPEED_TEST_UPLOAD_TARGET_URL || 'https://httpbin.org/post';
  const speedTestTimeoutMs = parseInt(process.env.SPEED_TEST_TIMEOUT_MS || '60000', 10);
  const speedTestMaxConcurrent = parseInt(process.env.SPEED_TEST_MAX_CONCURRENT || '5', 10);

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
  if (rotationCommandConcurrency < 1) {
    throw new Error('ROTATION_COMMAND_CONCURRENCY must be at least 1');
  }
  if (periodicRotationCommandMaxRetries < 0) {
    throw new Error('PERIODIC_ROTATION_COMMAND_MAX_RETRIES must be at least 0');
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

  /** Default on (like IP rotation); set DUPLICATE_IP_SNAPSHOT_ENABLED=false to disable. */
  const duplicateIpSnapshotEnabled = process.env.DUPLICATE_IP_SNAPSHOT_ENABLED !== 'false';
  const duplicateIpSnapshotIntervalMs = parseInt(
    process.env.DUPLICATE_IP_SNAPSHOT_INTERVAL_MS || '300000',
    10
  );
  const duplicateIpSnapshotRetentionDays = parseInt(
    process.env.DUPLICATE_IP_SNAPSHOT_RETENTION_DAYS || '90',
    10
  );
  if (duplicateIpSnapshotIntervalMs < 60_000) {
    throw new Error('DUPLICATE_IP_SNAPSHOT_INTERVAL_MS must be at least 60000ms (1 minute)');
  }
  if (duplicateIpSnapshotRetentionDays < 1) {
    throw new Error('DUPLICATE_IP_SNAPSHOT_RETENTION_DAYS must be at least 1');
  }

  const proxySyncConcurrency = parseInt(process.env.PROXY_SYNC_CONCURRENCY || '20', 10);
  if (proxySyncConcurrency < 1) {
    throw new Error('PROXY_SYNC_CONCURRENCY must be at least 1');
  }

  return {
    database: {
      url: process.env.DATABASE_URL!,
      proxySyncConcurrency,
    },
    xproxy: {
      apiUrl: process.env.XPROXY_API_URL!,
      apiEndpoint: process.env.XPROXY_API_ENDPOINT || '/api/devices',
      loginUrl: process.env.XPROXY_LOGIN_URL || 'https://proxyapi.jumpermedia.co/v2/auth/login',
      loginEmail: process.env.XPROXY_LOGIN_EMAIL!,
      loginPassword: process.env.XPROXY_LOGIN_PASSWORD!,
      timeoutMs: parseInt(process.env.XPROXY_API_TIMEOUT_MS || '30000', 10),
    },
    testing: {
      targetUrl: process.env.TEST_TARGET_URL || 'https://api.ipify.org?format=json',
      intervalMs: testIntervalMs,
      requestTimeoutMs,
      rotationThreshold,
      testInactiveProxies: process.env.TEST_INACTIVE_PROXIES === 'true',
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
      commandConcurrency: rotationCommandConcurrency,
      periodicCommandMaxRetries: periodicRotationCommandMaxRetries,
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
    speedTest: {
      enabled: speedTestEnabled,
      intervalMs: speedTestIntervalMs,
      targetUrl: speedTestTargetUrl,
      uploadTargetUrl: speedTestUploadTargetUrl,
      timeoutMs: speedTestTimeoutMs,
      maxConcurrentTests: speedTestMaxConcurrent,
    },
    logging: {
      level: process.env.LOG_LEVEL || 'info',
    },
    rotationTracking: {
      verificationWaitTimeMs: parseInt(process.env.ROTATION_VERIFICATION_WAIT_TIME_MS || '15000', 10),
      maxVerificationAttempts: parseInt(process.env.ROTATION_MAX_VERIFICATION_ATTEMPTS || '5', 10),
      verificationTimeoutMs: parseInt(process.env.ROTATION_VERIFICATION_TIMEOUT_MS || '90000', 10), // 90 seconds default (15s * 5 + buffer)
    },
    duplicateIpSnapshot: {
      enabled: duplicateIpSnapshotEnabled,
      intervalMs: duplicateIpSnapshotIntervalMs,
      retentionDays: duplicateIpSnapshotRetentionDays,
    },
  };
}

export const config = validateConfig();

