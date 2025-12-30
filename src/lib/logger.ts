import pino from 'pino';
import { randomBytes } from 'crypto';
import { mkdirSync, existsSync } from 'fs';
import { join } from 'path';

/**
 * Generate correlation ID for request tracing
 */
function generateCorrelationId(): string {
  return randomBytes(8).toString('hex');
}

/**
 * Get or create correlation ID from async local storage
 * This allows tracking requests across async boundaries
 */
const correlationIdStore = new Map<number, string>();

function getCorrelationId(): string {
  const threadId = (process as any).threadId || 0;
  if (!correlationIdStore.has(threadId)) {
    correlationIdStore.set(threadId, generateCorrelationId());
  }
  return correlationIdStore.get(threadId)!;
}

function setCorrelationId(id: string): void {
  const threadId = (process as any).threadId || 0;
  correlationIdStore.set(threadId, id);
}

/**
 * Setup log directory and file paths
 */
const LOGS_DIR = process.env.LOGS_DIR || './logs';
const LOG_FILE = join(LOGS_DIR, 'app.log');
const ERROR_LOG_FILE = join(LOGS_DIR, 'error.log');

/**
 * Determine if we should log to console
 * Log to console if LOG_TO_CONSOLE is true, or if not in production
 */
const shouldLogToConsole = process.env.LOG_TO_CONSOLE === 'true' || process.env.NODE_ENV !== 'production';

/**
 * Create logger streams
 * - File stream: All logs go to app.log
 * - Error file stream: Errors also go to error.log
 * - Console stream: Pretty formatted output (if enabled)
 */
const streams: Array<{ level: string; stream: any }> = [];

// Always try to log to file (pino.destination will handle errors gracefully)
// Attempt to create directory if it doesn't exist, but proceed anyway
try {
  if (!existsSync(LOGS_DIR)) {
    mkdirSync(LOGS_DIR, { recursive: true });
  }
} catch (err) {
  // Directory creation failed, but we'll still try to write (may fail silently)
  console.warn('Warning: Could not create logs directory, file logging may not work');
}

streams.push({
  level: 'info',
  stream: pino.destination({
    dest: LOG_FILE,
    sync: false, // Async writes for better performance
  }),
});

// Separate error log file
streams.push({
  level: 'error',
  stream: pino.destination({
    dest: ERROR_LOG_FILE,
    sync: false,
  }),
});

// Optionally log to console with pretty formatting
if (shouldLogToConsole) {
  streams.push({
    level: process.env.LOG_LEVEL || 'info',
    stream: pino.transport({
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'HH:MM:ss',
        ignore: 'pid,hostname',
        singleLine: false,
        hideObject: false,
        messageFormat: '{msg}',
      },
    }),
  });
}

/**
 * Create logger instance with correlation ID support
 * Uses multi-stream to write to both console (pretty) and files
 */
const baseLogger = pino(
  {
    level: process.env.LOG_LEVEL || 'info',
    base: {
      service: 'x-proxy-tester',
    },
  },
  streams.length > 0 ? pino.multistream(streams) : undefined
);

/**
 * Enhanced logger with correlation ID
 */
export const logger = {
  trace: (obj: any, msg?: string) => {
    baseLogger.trace({ ...obj, correlationId: getCorrelationId() }, msg);
  },
  debug: (obj: any, msg?: string) => {
    baseLogger.debug({ ...obj, correlationId: getCorrelationId() }, msg);
  },
  info: (obj: any, msg?: string) => {
    baseLogger.info({ ...obj, correlationId: getCorrelationId() }, msg);
  },
  warn: (obj: any, msg?: string) => {
    baseLogger.warn({ ...obj, correlationId: getCorrelationId() }, msg);
  },
  error: (obj: any, msg?: string) => {
    baseLogger.error({ ...obj, correlationId: getCorrelationId() }, msg);
  },
  fatal: (obj: any, msg?: string) => {
    baseLogger.fatal({ ...obj, correlationId: getCorrelationId() }, msg);
  },
  child: (bindings: pino.Bindings) => {
    return baseLogger.child({ ...bindings, correlationId: getCorrelationId() });
  },
};

/**
 * Create a child logger with specific correlation ID
 * Useful for tracking specific operations
 */
export function createLoggerWithCorrelation(correlationId?: string): typeof logger {
  const id = correlationId || generateCorrelationId();
  setCorrelationId(id);

  return {
    trace: (obj: any, msg?: string) => {
      baseLogger.trace({ ...obj, correlationId: id }, msg);
    },
    debug: (obj: any, msg?: string) => {
      baseLogger.debug({ ...obj, correlationId: id }, msg);
    },
    info: (obj: any, msg?: string) => {
      baseLogger.info({ ...obj, correlationId: id }, msg);
    },
    warn: (obj: any, msg?: string) => {
      baseLogger.warn({ ...obj, correlationId: id }, msg);
    },
    error: (obj: any, msg?: string) => {
      baseLogger.error({ ...obj, correlationId: id }, msg);
    },
    fatal: (obj: any, msg?: string) => {
      baseLogger.fatal({ ...obj, correlationId: id }, msg);
    },
    child: (bindings: pino.Bindings) => {
      return baseLogger.child({ ...bindings, correlationId: id });
    },
  };
}

/**
 * Get current correlation ID
 */
export function getCurrentCorrelationId(): string {
  return getCorrelationId();
}
