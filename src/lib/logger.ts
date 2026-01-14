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
let canWriteToLogs = false;
try {
  if (!existsSync(LOGS_DIR)) {
    mkdirSync(LOGS_DIR, { recursive: true });
  }
  
  // Test if we can write to the logs directory
  const testFile = join(LOGS_DIR, '.write-test');
  try {
    require('fs').writeFileSync(testFile, 'test');
    require('fs').unlinkSync(testFile);
    canWriteToLogs = true;
  } catch (writeErr: any) {
    if (writeErr.code === 'EACCES' || writeErr.code === 'EPERM') {
      console.warn(
        `⚠️  No write permission to ${LOGS_DIR}. File logging disabled. ` +
        `Fix permissions on host: chmod 777 ./logs (or chown -R 1001:1001 ./logs)`
      );
      canWriteToLogs = false;
    } else {
      // Other errors, still try to proceed
      canWriteToLogs = true;
    }
  }
} catch (err: any) {
  console.warn(`Warning: Could not create/access logs directory: ${err.message}`);
  canWriteToLogs = false;
}

// Only add file streams if we have write permission
if (canWriteToLogs) {
  try {
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
  } catch (err: any) {
    console.warn(
      `Warning: Could not set up file logging: ${err.message}. ` +
      `Logging to console only.`
    );
  }
} else {
  console.warn('⚠️  File logging disabled due to permission issues. Logging to console only.');
}

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

type LogBindings = Record<string, unknown>;

function buildLogArgs(
  correlationId: string,
  objOrMsg?: unknown,
  msg?: string
): { obj: LogBindings; msg?: string } {
  if (typeof objOrMsg === 'string') {
    return { obj: { correlationId }, msg: objOrMsg };
  }

  if (objOrMsg instanceof Error) {
    return { obj: { err: objOrMsg, correlationId }, msg };
  }

  if (objOrMsg && typeof objOrMsg === 'object') {
    return { obj: { ...(objOrMsg as LogBindings), correlationId }, msg };
  }

  return { obj: { correlationId }, msg };
}

/**
 * Enhanced logger with correlation ID
 * Handles both object-first and message-first calling patterns
 */
export const logger = {
  trace: (objOrMsg: any, msg?: string) => {
    if (typeof objOrMsg === 'string') {
      baseLogger.trace({ correlationId: getCorrelationId() }, objOrMsg);
    } else {
      baseLogger.trace({ ...objOrMsg, correlationId: getCorrelationId() }, msg);
    }
  },
  debug: (objOrMsg: any, msg?: string) => {
    if (typeof objOrMsg === 'string') {
      baseLogger.debug({ correlationId: getCorrelationId() }, objOrMsg);
    } else {
      baseLogger.debug({ ...objOrMsg, correlationId: getCorrelationId() }, msg);
    }
  },
  info: (objOrMsg: any, msg?: string) => {
    if (typeof objOrMsg === 'string') {
      baseLogger.info({ correlationId: getCorrelationId() }, objOrMsg);
    } else {
      baseLogger.info({ ...objOrMsg, correlationId: getCorrelationId() }, msg);
    }
  },
  warn: (objOrMsg: any, msg?: string) => {
    if (typeof objOrMsg === 'string') {
      baseLogger.warn({ correlationId: getCorrelationId() }, objOrMsg);
    } else {
      baseLogger.warn({ ...objOrMsg, correlationId: getCorrelationId() }, msg);
    }
  },
  error: (objOrMsg: any, msg?: string) => {
    if (typeof objOrMsg === 'string') {
      baseLogger.error({ correlationId: getCorrelationId() }, objOrMsg);
    } else {
      baseLogger.error({ ...objOrMsg, correlationId: getCorrelationId() }, msg);
    }
  },
  fatal: (objOrMsg: any, msg?: string) => {
    if (typeof objOrMsg === 'string') {
      baseLogger.fatal({ correlationId: getCorrelationId() }, objOrMsg);
    } else {
      baseLogger.fatal({ ...objOrMsg, correlationId: getCorrelationId() }, msg);
    }
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
    trace: (objOrMsg: any, msg?: string) => {
      if (typeof objOrMsg === 'string') {
        baseLogger.trace({ correlationId: id }, objOrMsg);
      } else {
        baseLogger.trace({ ...objOrMsg, correlationId: id }, msg);
      }
    },
    debug: (objOrMsg: any, msg?: string) => {
      if (typeof objOrMsg === 'string') {
        baseLogger.debug({ correlationId: id }, objOrMsg);
      } else {
        baseLogger.debug({ ...objOrMsg, correlationId: id }, msg);
      }
    },
    info: (objOrMsg: any, msg?: string) => {
      if (typeof objOrMsg === 'string') {
        baseLogger.info({ correlationId: id }, objOrMsg);
      } else {
        baseLogger.info({ ...objOrMsg, correlationId: id }, msg);
      }
    },
    warn: (objOrMsg: any, msg?: string) => {
      if (typeof objOrMsg === 'string') {
        baseLogger.warn({ correlationId: id }, objOrMsg);
      } else {
        baseLogger.warn({ ...objOrMsg, correlationId: id }, msg);
      }
    },
    error: (objOrMsg: any, msg?: string) => {
      if (typeof objOrMsg === 'string') {
        baseLogger.error({ correlationId: id }, objOrMsg);
      } else {
        baseLogger.error({ ...objOrMsg, correlationId: id }, msg);
      }
    },
    fatal: (objOrMsg: any, msg?: string) => {
      if (typeof objOrMsg === 'string') {
        baseLogger.fatal({ correlationId: id }, objOrMsg);
      } else {
        baseLogger.fatal({ ...objOrMsg, correlationId: id }, msg);
      }
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
