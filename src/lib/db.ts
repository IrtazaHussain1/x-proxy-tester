import { PrismaClient } from '@prisma/client';
import { logger } from './logger';
import { recordDatabaseError, recordDatabaseQuery } from './metrics';

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
 * - connection_limit: Maximum number of connections (default: 10)
 * - pool_timeout: Connection timeout in seconds (default: 20)
 * Example: mysql://user:pass@host:port/db?connection_limit=20&pool_timeout=30
 */
const prisma = new PrismaClient({
  log: [
    { level: 'error', emit: 'event' },
    { level: 'warn', emit: 'event' },
  ],
  datasources: {
    db: {
      url: process.env.DATABASE_URL,
    },
  },
});

// Configure connection pool (via DATABASE_URL query params or defaults)
// Example: mysql://user:pass@host:port/db?connection_limit=10&pool_timeout=20

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
 * Health check for database
 */
export async function checkDatabaseHealth(): Promise<{
  connected: boolean;
  latency?: number;
  error?: string;
}> {
  try {
    const startTime = Date.now();
    await retryWithBackoff(
      async () => {
        await prisma.$queryRaw`SELECT 1`;
      },
      'health_check',
      2 // Fewer retries for health check
    );
    const latency = Date.now() - startTime;
    return { connected: true, latency };
  } catch (error: any) {
    return {
      connected: false,
      error: error?.message || 'Unknown error',
    };
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
  $transaction: async (args: any) => {
    recordDatabaseQuery();
    return retryWithBackoff(() => prisma.$transaction(args), 'transaction');
  },
  $queryRaw: async (args: any) => {
    recordDatabaseQuery();
    return retryWithBackoff(() => prisma.$queryRaw(args), 'queryRaw');
  },
};

// Export both - use prismaWithRetry for critical operations, prisma for non-critical
export { prisma };

// Ensure the Prisma client disconnects when the process exits
process.on('beforeExit', async () => {
  await prisma.$disconnect();
  logger.info('Prisma client disconnected');
});
