import { PrismaClient } from '@prisma/client';
import { logger } from './logger';
import { recordDatabaseError, recordDatabaseQuery } from './metrics';
import { getOptimizedDatabaseUrl } from './db-pool-config';

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

      // Check for connection pool exhaustion
      const isConnectionPoolError = 
        error?.message?.includes('connection pool') ||
        error?.message?.includes('Timed out fetching a new connection');
      
      if (isConnectionPoolError && attempt < maxRetries) {
        // For connection pool errors, use longer delays to allow pool to recover
        const delay = Math.min(calculateBackoffDelay(attempt) * 2, 60000); // Max 60 seconds
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
 * - connection_limit: Maximum number of connections (default: 50, optimized for high concurrency)
 * - pool_timeout: Connection timeout in seconds (default: 20)
 * - connect_timeout: Time to establish connection in seconds (default: 10)
 * 
 * The connection pool is automatically optimized via getOptimizedDatabaseUrl()
 * to handle high-concurrency production workloads (hundreds of concurrent proxy tests).
 * 
 * Example: mysql://user:pass@host:port/db?connection_limit=50&pool_timeout=20&connect_timeout=10
 */
const prisma = new PrismaClient({
  log: [
    { level: 'error', emit: 'event' },
    { level: 'warn', emit: 'event' },
  ],
  datasources: {
    db: {
      url: getOptimizedDatabaseUrl(),
    },
  },
});

prisma.$on('error', (e: any) => {
  logger.error({ error: e }, 'Prisma error');
  recordDatabaseError();
});

prisma.$on('warn', (e: any) => {
  logger.warn({ warning: e }, 'Prisma warning');
});

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
 * Wrapped Prisma client with retry logic for critical operations
 */
export const prismaWithRetry = {
  ...prisma,
  proxy: {
    ...prisma.proxy,
    findUnique: async (args: any) => {
      recordDatabaseQuery();
      return retryWithBackoff(() => prisma.proxy.findUnique(args), 'proxy.findUnique');
    },
    findMany: async (args: any) => {
      recordDatabaseQuery();
      return retryWithBackoff(() => prisma.proxy.findMany(args), 'proxy.findMany');
    },
    create: async (args: any) => {
      recordDatabaseQuery();
      return retryWithBackoff(() => prisma.proxy.create(args), 'proxy.create');
    },
    update: async (args: any) => {
      recordDatabaseQuery();
      return retryWithBackoff(() => prisma.proxy.update(args), 'proxy.update');
    },
    upsert: async (args: any) => {
      recordDatabaseQuery();
      return retryWithBackoff(() => prisma.proxy.upsert(args), 'proxy.upsert');
    },
  },
  proxyRequest: {
    ...prisma.proxyRequest,
    create: async (args: any) => {
      recordDatabaseQuery();
      return retryWithBackoff(() => prisma.proxyRequest.create(args), 'proxyRequest.create');
    },
    createMany: async (args: any) => {
      recordDatabaseQuery();
      return retryWithBackoff(() => prisma.proxyRequest.createMany(args), 'proxyRequest.createMany');
    },
    findMany: async (args: any) => {
      recordDatabaseQuery();
      return retryWithBackoff(() => prisma.proxyRequest.findMany(args), 'proxyRequest.findMany');
    },
  },
  speedTest: {
    ...prisma.speedTest,
    create: async (args: any) => {
      recordDatabaseQuery();
      return retryWithBackoff(() => prisma.speedTest.create(args), 'speedTest.create');
    },
    findMany: async (args: any) => {
      recordDatabaseQuery();
      return retryWithBackoff(() => prisma.speedTest.findMany(args), 'speedTest.findMany');
    },
  },
  rotationCycle: {
    ...prisma.rotationCycle,
    create: async (args: any) => {
      recordDatabaseQuery();
      return retryWithBackoff(() => prisma.rotationCycle.create(args), 'rotationCycle.create');
    },
    update: async (args: any) => {
      recordDatabaseQuery();
      return retryWithBackoff(() => prisma.rotationCycle.update(args), 'rotationCycle.update');
    },
    findUnique: async (args: any) => {
      recordDatabaseQuery();
      return retryWithBackoff(() => prisma.rotationCycle.findUnique(args), 'rotationCycle.findUnique');
    },
    findMany: async (args: any) => {
      recordDatabaseQuery();
      return retryWithBackoff(() => prisma.rotationCycle.findMany(args), 'rotationCycle.findMany');
    },
  },
  ipRotation: {
    ...prisma.ipRotation,
    create: async (args: any) => {
      recordDatabaseQuery();
      return retryWithBackoff(() => prisma.ipRotation.create(args), 'ipRotation.create');
    },
    update: async (args: any) => {
      recordDatabaseQuery();
      return retryWithBackoff(() => prisma.ipRotation.update(args), 'ipRotation.update');
    },
    findUnique: async (args: any) => {
      recordDatabaseQuery();
      return retryWithBackoff(() => prisma.ipRotation.findUnique(args), 'ipRotation.findUnique');
    },
    findMany: async (args: any) => {
      recordDatabaseQuery();
      return retryWithBackoff(() => prisma.ipRotation.findMany(args), 'ipRotation.findMany');
    },
    findFirst: async (args: any) => {
      recordDatabaseQuery();
      return retryWithBackoff(() => prisma.ipRotation.findFirst(args), 'ipRotation.findFirst');
    },
  },
  $transaction: async (args: any) => {
    recordDatabaseQuery();
    return retryWithBackoff(() => prisma.$transaction(args), 'transaction');
  },
  $queryRaw: async (args: any) => {
    recordDatabaseQuery();
    return retryWithBackoff(() => prisma.$queryRaw(args), 'queryRaw');
  },
  $queryRawUnsafe: async (...args: any[]) => {
    recordDatabaseQuery();
    return retryWithBackoff(() => (prisma.$queryRawUnsafe as any)(...args), 'queryRawUnsafe');
  },
  $executeRawUnsafe: async (...args: any[]) => {
    recordDatabaseQuery();
    return retryWithBackoff(() => (prisma.$executeRawUnsafe as any)(...args), 'executeRawUnsafe');
  },
};

// Export both - use prismaWithRetry for critical operations, prisma for non-critical
export { prisma };

// Ensure the Prisma client disconnects when the process exits
process.on('beforeExit', async () => {
  await prisma.$disconnect();
  logger.info('Prisma client disconnected');
});
