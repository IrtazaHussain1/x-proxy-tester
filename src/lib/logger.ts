import pino from 'pino';
import { randomBytes } from 'crypto';

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
 * Create logger instance with correlation ID support
 */
const baseLogger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'HH:MM:ss',
      ignore: 'pid,hostname',
      singleLine: false,
      hideObject: false,
      messageFormat: '{msg}',
    },
  },
  base: {
    service: 'x-proxy-tester',
  },
});

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
