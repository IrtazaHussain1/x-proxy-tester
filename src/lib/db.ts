import { PrismaClient } from '@prisma/client';
import { logger } from './logger';
import { recordDatabaseError, recordDatabaseQuery } from './metrics';
import { getDatabaseUrlWithConnectionLimit } from './db-pool-config';

/**
 * Retry configuration
 */
const MAX_RETRIES = 5;
const INITIAL_RETRY_DELAY_MS = 1000; // 1 second
const MAX_RETRY_DELAY_MS = 30000; // 30 seconds

/**
 * Calculate exponential backoff delay
 */
function calculateBackoffDelay(attempt: number): number {
  const delay = INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt);
  return Math.min(delay, MAX_RETRY_DELAY_MS);
}

/**
 * Sleep for specified milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Extracts a best-effort string error code from nested Prisma/MySQL error payloads.
 */
function extractErrorCode(error: any): string {
  const candidates = [
    error?.code,
    error?.errno,
    error?.originalError?.code,
    error?.originalError?.errno,
    error?.cause?.code,
    error?.cause?.errno,
    error?.meta?.code,
  ];

  for (const candidate of candidates) {
    if (candidate !== undefined && candidate !== null) {
      return String(candidate);
    }
  }

  return '';
}

/**
 * Returns true for known transient row-lock errors.
 */
function isTransientLockError(error: any): boolean {
  const code = extractErrorCode(error);
  const message = typeof error?.message === 'string' ? error.message : '';

  // MySQL 1205: lock wait timeout, 1213: deadlock found
  if (code === '1205' || code === '1213') {
    return true;
  }

  return (
    message.includes('Lock wait timeout') ||
    message.includes('Deadlock found') ||
    /MysqlError\s*\{\s*code:\s*1205/.test(message) ||
    /MysqlError\s*\{\s*code:\s*1213/.test(message)
  );
}

/**
 * Retry function with exponential backoff
 */
async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  operation: string,
  maxRetries: number = MAX_RETRIES
): Promise<T> {
  let lastError: Error | unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await fn();
      if (attempt > 0) {
        logger.info({ operation, attempt }, 'Database operation succeeded after retry');
      }
      return result;
    } catch (error: any) {
      lastError = error;
      recordDatabaseError();

      // Don't retry on certain errors
      if (error?.code === 'P2002') {
        // Unique constraint violation - don't retry
        throw error;
      }

      if (isTransientLockError(error) && attempt < maxRetries) {
        // Jitter avoids many workers retrying in lockstep and re-contending the same rows.
        const delay = 500 + Math.floor(Math.random() * 400);
        logger.debug(
          { operation, attempt: attempt + 1, maxRetries, delay },
          'Lock wait timeout, retrying'
        );
        await sleep(delay);
        continue;
      }

      // Prisma: pool saturated or engine busy — same remediation as pool exhaustion
      const isTransactionStartTimeout =
        typeof error?.message === 'string' &&
        error.message.includes('Unable to start a transaction in the given time');

      // Check for connection pool exhaustion
      const isConnectionPoolError =
        isTransactionStartTimeout ||
        error?.message?.includes('connection pool') ||
        error?.message?.includes('Timed out fetching a new connection');

      if (isConnectionPoolError && attempt < maxRetries) {
        // Jitter prevents all waiting operations from retrying at exactly the same moment
        // (thundering herd), which would immediately re-exhaust the pool.
        const base = Math.min(calculateBackoffDelay(attempt) * 2, 30000);
        const delay = base + Math.floor(Math.random() * base * 0.5);
        logger.warn(
          {
            operation,
            attempt: attempt + 1,
            maxRetries,
            delay,
            error: 'Connection pool exhausted',
          },
          'Connection pool exhausted, waiting longer before retry'
        );
        await sleep(delay);
        continue;
      }

      if (attempt < maxRetries) {
        const delay = calculateBackoffDelay(attempt);
        logger.warn(
          {
            operation,
            attempt: attempt + 1,
            maxRetries,
            delay,
            error: error?.message || String(error),
          },
          'Database operation failed, retrying with exponential backoff'
        );
        await sleep(delay);
      } else {
        logger.error(
          {
            operation,
            attempts: attempt + 1,
            error: error?.message || String(error),
          },
          'Database operation failed after all retries'
        );
      }
    }
  }

  throw lastError;
}

/**
 * Create Prisma client with connection pool configuration
 * Connection pool is configured via DATABASE_URL query parameters:
 * - connection_limit: Maximum number of connections (default: 100, optimized for high concurrency)
 * - pool_timeout: Connection timeout in seconds (default: 20)
 * - connect_timeout: Time to establish connection in seconds (default: 10)
 * 
 * The connection pool is automatically optimized via getOptimizedDatabaseUrl()
 * to handle high-concurrency production workloads (hundreds of concurrent proxy tests).
 * 
 * Example: mysql://user:pass@host:port/db?connection_limit=50&pool_timeout=20&connect_timeout=10
 */
// ---------------------------------------------------------------------------
// Prisma client factory
// ---------------------------------------------------------------------------

function makePrismaClient(url: string): PrismaClient {
  const client = new PrismaClient({
    log: [
      { level: 'error', emit: 'event' },
      { level: 'warn', emit: 'event' },
    ],
    datasources: { db: { url } },
  });

  client.$on('error', (e: any) => {
    const msg = typeof e?.message === 'string' ? e.message : String(e?.message ?? e);
    if (isTransientLockError(e) || msg.includes('1205') || msg.includes('Lock wait timeout')) {
      logger.debug({ error: e }, 'Prisma transient lock error (retries handle this)');
      return;
    }
    if (msg.includes('Timed out fetching a new connection from the connection pool')) {
      logger.debug({ error: e }, 'Prisma transient pool timeout (retries handle this)');
      return;
    }
    logger.error({ error: e }, 'Prisma error');
    recordDatabaseError();
  });

  client.$on('warn', (e: any) => {
    logger.warn({ warning: e }, 'Prisma warning');
  });

  return client;
}

// ---------------------------------------------------------------------------
// Named connection pools
//
//  writeDb       — write workers, batch-writer (INSERT-heavy path)   20 conns
//  backgroundDb  — aggregation, archival, snapshots                    8 conns
//  prisma        — API reads, health checks, general use              15 conns
//
// Total: 43, well under MySQL max_connections (300).
// Sizes are tunable via env vars; defaults are chosen conservatively.
// ---------------------------------------------------------------------------

const WRITE_POOL_LIMIT      = parseInt(process.env.DB_WRITE_CONNECTION_LIMIT      ?? '20', 10);
const BACKGROUND_POOL_LIMIT = parseInt(process.env.DB_BACKGROUND_CONNECTION_LIMIT ?? '8',  10);
const READ_POOL_LIMIT       = parseInt(process.env.DB_CONNECTION_LIMIT             ?? '15', 10);

/**
 * Dedicated connection pool for write workers and batch-writer.
 * All prismaWithRetry calls are backed by this pool.
 */
export const writeDb = makePrismaClient(getDatabaseUrlWithConnectionLimit(WRITE_POOL_LIMIT));

/**
 * Dedicated connection pool for background/aggregation jobs.
 * Import this in daily-aggregation.ts, archival.ts, duplicate-ip-snapshot.ts.
 */
export const backgroundDb = makePrismaClient(getDatabaseUrlWithConnectionLimit(BACKGROUND_POOL_LIMIT));

// General-purpose / API read pool (smaller now that writes have their own pool).
const prisma = makePrismaClient(getDatabaseUrlWithConnectionLimit(READ_POOL_LIMIT));

/**
 * Test database connection with retry
 */
export async function testConnection(): Promise<boolean> {
  try {
    await retryWithBackoff(
      async () => {
        await prisma.$queryRaw`SELECT 1`;
        return true;
      },
      'connection_test'
    );
    return true;
  } catch (error) {
    logger.error({ error }, 'Database connection test failed');
    return false;
  }
}

/**
 * Wait for database to be ready with retries
 * Useful for Docker startup when DB might not be ready immediately
 */
export async function waitForDatabase(
  maxAttempts: number = 30
): Promise<boolean> {
  logger.info('Waiting for database to be ready...');
  
  try {
    // Use retryWithBackoff for proper retry logic
    await retryWithBackoff(
      async () => {
        await prisma.$queryRaw`SELECT 1`;
        return true;
      },
      'wait_for_database',
      maxAttempts
    );
    
    // Test that we can actually connect and query
    await retryWithBackoff(
      async () => {
        await prisma.$queryRaw`SELECT DATABASE()`;
        return true;
      },
      'wait_for_database_verify',
      3
    );
    
    logger.info('Database is ready and verified');
    return true;
  } catch (error: any) {
    logger.error(
      {
        attempts: maxAttempts,
        error: error?.message || 'Connection failed',
      },
      'Database connection failed after all retries'
    );
    return false;
  }
}

/**
 * Health check cache to prevent excessive database queries
 * Cache health check results for 5 seconds to reduce connection pool pressure
 */
let healthCheckCache: {
  result: { connected: boolean; latency?: number; error?: string };
  timestamp: number;
} | null = null;
const HEALTH_CHECK_CACHE_TTL_MS = 5000; // 5 seconds

/**
 * Health check for database
 * 
 * Cached for 5 seconds to prevent connection pool exhaustion when called frequently.
 * During connection pool exhaustion, returns cached result or fails gracefully without retrying.
 */
export async function checkDatabaseHealth(): Promise<{
  connected: boolean;
  latency?: number;
  error?: string;
}> {
  const now = Date.now();
  
  // Return cached result if still valid
  if (healthCheckCache && (now - healthCheckCache.timestamp) < HEALTH_CHECK_CACHE_TTL_MS) {
    return healthCheckCache.result;
  }

  try {
    const startTime = Date.now();
    // Use direct prisma call (not retry wrapper) for health checks to avoid connection pool exhaustion
    // If pool is exhausted, fail fast without retrying
    await prisma.$queryRaw`SELECT 1`;
    const latency = Date.now() - startTime;
    const result = { connected: true, latency };
    
    // Cache successful result
    healthCheckCache = { result, timestamp: now };
    return result;
  } catch (error: any) {
    // Check if it's a connection pool error
    const isConnectionPoolError = 
      error?.message?.includes('connection pool') ||
      error?.message?.includes('Timed out fetching a new connection');
    
    // If pool is exhausted, return cached result if available, otherwise return error
    if (isConnectionPoolError && healthCheckCache) {
      logger.warn('Connection pool exhausted during health check, using cached result');
      return healthCheckCache.result;
    }
    
    const result = {
      connected: false,
      error: error?.message || 'Unknown error',
    };
    
    // Cache failed result for shorter time (1 second) to allow quick recovery detection
    healthCheckCache = { result, timestamp: now };
    return result;
  }
}

/**
 * Strict capacity probe for heavy background jobs.
 *
 * Unlike checkDatabaseHealth(), this does NOT use cached success when the pool is exhausted.
 * It is intended to decide whether expensive aggregation/snapshot jobs should run right now.
 */
export async function hasDatabaseCapacityForBackgroundJobs(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch (error: any) {
    const isConnectionPoolError =
      error?.message?.includes('connection pool') ||
      error?.message?.includes('Timed out fetching a new connection');

    if (isConnectionPoolError) {
      logger.warn('Database pool exhausted, skipping heavy background job tick');
      return false;
    }

    return false;
  }
}

/**
 * Wrapped Prisma client with retry logic for critical write-path operations.
 * Backed by `writeDb` (dedicated 20-connection write pool) so background jobs
 * and API reads cannot starve write workers.
 */
export const prismaWithRetry = {
  ...writeDb,
  proxy: {
    ...writeDb.proxy,
    findUnique: async (args: any) => {
      recordDatabaseQuery();
      return retryWithBackoff(() => writeDb.proxy.findUnique(args), 'proxy.findUnique');
    },
    findMany: async (args: any) => {
      recordDatabaseQuery();
      return retryWithBackoff(() => writeDb.proxy.findMany(args), 'proxy.findMany');
    },
    create: async (args: any) => {
      recordDatabaseQuery();
      return retryWithBackoff(() => writeDb.proxy.create(args), 'proxy.create');
    },
    update: async (args: any) => {
      recordDatabaseQuery();
      return retryWithBackoff(() => writeDb.proxy.update(args), 'proxy.update');
    },
    upsert: async (args: any) => {
      recordDatabaseQuery();
      return retryWithBackoff(() => writeDb.proxy.upsert(args), 'proxy.upsert');
    },
  },
  proxyRequest: {
    ...writeDb.proxyRequest,
    create: async (args: any) => {
      recordDatabaseQuery();
      return retryWithBackoff(() => writeDb.proxyRequest.create(args), 'proxyRequest.create');
    },
    createMany: async (args: any) => {
      recordDatabaseQuery();
      return retryWithBackoff(() => writeDb.proxyRequest.createMany(args), 'proxyRequest.createMany');
    },
    findMany: async (args: any) => {
      recordDatabaseQuery();
      return retryWithBackoff(() => writeDb.proxyRequest.findMany(args), 'proxyRequest.findMany');
    },
  },
  speedTest: {
    ...writeDb.speedTest,
    create: async (args: any) => {
      recordDatabaseQuery();
      return retryWithBackoff(() => writeDb.speedTest.create(args), 'speedTest.create');
    },
    findMany: async (args: any) => {
      recordDatabaseQuery();
      return retryWithBackoff(() => writeDb.speedTest.findMany(args), 'speedTest.findMany');
    },
  },
  rotationCycle: {
    ...writeDb.rotationCycle,
    create: async (args: any) => {
      recordDatabaseQuery();
      return retryWithBackoff(() => writeDb.rotationCycle.create(args), 'rotationCycle.create');
    },
    update: async (args: any) => {
      recordDatabaseQuery();
      return retryWithBackoff(() => writeDb.rotationCycle.update(args), 'rotationCycle.update');
    },
    findUnique: async (args: any) => {
      recordDatabaseQuery();
      return retryWithBackoff(() => writeDb.rotationCycle.findUnique(args), 'rotationCycle.findUnique');
    },
    findMany: async (args: any) => {
      recordDatabaseQuery();
      return retryWithBackoff(() => writeDb.rotationCycle.findMany(args), 'rotationCycle.findMany');
    },
  },
  ipRotation: {
    ...writeDb.ipRotation,
    create: async (args: any) => {
      recordDatabaseQuery();
      return retryWithBackoff(() => writeDb.ipRotation.create(args), 'ipRotation.create');
    },
    update: async (args: any) => {
      recordDatabaseQuery();
      return retryWithBackoff(() => writeDb.ipRotation.update(args), 'ipRotation.update');
    },
    findUnique: async (args: any) => {
      recordDatabaseQuery();
      return retryWithBackoff(() => writeDb.ipRotation.findUnique(args), 'ipRotation.findUnique');
    },
    findMany: async (args: any) => {
      recordDatabaseQuery();
      return retryWithBackoff(() => writeDb.ipRotation.findMany(args), 'ipRotation.findMany');
    },
    findFirst: async (args: any) => {
      recordDatabaseQuery();
      return retryWithBackoff(() => writeDb.ipRotation.findFirst(args), 'ipRotation.findFirst');
    },
  },
  $transaction: async (first: any, second?: any) => {
    recordDatabaseQuery();
    return retryWithBackoff(
      () =>
        second !== undefined
          ? writeDb.$transaction(first, second)
          : writeDb.$transaction(first),
      'transaction'
    );
  },
  $queryRaw: async (args: any) => {
    recordDatabaseQuery();
    return retryWithBackoff(() => writeDb.$queryRaw(args), 'queryRaw');
  },
  $queryRawUnsafe: async (...args: any[]) => {
    recordDatabaseQuery();
    return retryWithBackoff(() => (writeDb.$queryRawUnsafe as any)(...args), 'queryRawUnsafe');
  },
  $executeRawUnsafe: async (...args: any[]) => {
    recordDatabaseQuery();
    return retryWithBackoff(() => (writeDb.$executeRawUnsafe as any)(...args), 'executeRawUnsafe');
  },
};

// Export both - use prismaWithRetry for critical operations, prisma for non-critical
export { prisma };

// Ensure all Prisma clients disconnect when the process exits
process.on('beforeExit', async () => {
  await Promise.allSettled([
    prisma.$disconnect(),
    writeDb.$disconnect(),
    backgroundDb.$disconnect(),
  ]);
  logger.info('Prisma clients disconnected');
});
