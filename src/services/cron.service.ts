/**
 * Central registry for wall-clock cron jobs and coarse app timers (intervals / one-shot delays).
 *
 * Why `node-cron` (optional dependency) for cron-shaped work:
 * - Parses standard 5-field expressions (minute hour dom month dow) instead of hand-rolled UTC math.
 * - Optional IANA timezone via `CRON_TZ` (e.g. `America/Toronto`); defaults to UTC.
 * - Slightly drift-resistant vs `setInterval(86400000)` after long process sleep.
 *
 * What stays outside this module: high-frequency loops (proxy test tick, batch-writer flush,
 * circuit breaker, BullMQ workers) — those are not cron jobs and should remain colocated.
 *
 * @module services/cron.service
 */

import cron from 'node-cron';
import { logger } from '../lib/logger';

type RegistryEntry = {
  kind: 'cron' | 'interval' | 'timeout';
  name: string;
  stop: () => void;
};

const registry = new Map<string, RegistryEntry>();

function unregister(name: string): void {
  const entry = registry.get(name);
  if (!entry) return;
  try {
    entry.stop();
  } catch (err) {
    logger.warn({ name, err }, 'Error stopping scheduled job');
  }
  registry.delete(name);
}

/**
 * Registers a cron task (5-field expression). Replaces any existing registration with the same name.
 */
export function registerCronJob(
  name: string,
  cronExpression: string,
  handler: () => void | Promise<void>,
  options?: { timezone?: string }
): boolean {
  unregister(name);
  if (!cron.validate(cronExpression)) {
    logger.error({ name, cronExpression }, 'Invalid cron expression — job not registered');
    return false;
  }
  const timezone = options?.timezone ?? process.env.CRON_TZ ?? 'UTC';
  const task = cron.schedule(
    cronExpression,
    () => {
      void Promise.resolve(handler()).catch((err) => {
        logger.error({ name, err }, 'Cron job handler failed');
      });
    },
    { timezone }
  );
  registry.set(name, {
    kind: 'cron',
    name,
    stop: () => {
      task.stop();
    },
  });
  logger.info({ name, cronExpression, timezone }, 'Cron job registered');
  return true;
}

/**
 * Registers a fixed-period interval. Replaces any existing registration with the same name.
 */
export function registerIntervalJob(
  name: string,
  periodMs: number,
  handler: () => void | Promise<void>,
  options?: { runImmediately?: boolean }
): void {
  unregister(name);
  if (options?.runImmediately) {
    void Promise.resolve(handler()).catch((err) => {
      logger.error({ name, err }, 'Interval job initial run failed');
    });
  }
  const id = setInterval(() => {
    void Promise.resolve(handler()).catch((err) => {
      logger.error({ name, err }, 'Interval job tick failed');
    });
  }, periodMs);
  registry.set(name, {
    kind: 'interval',
    name,
    stop: () => {
      clearInterval(id);
    },
  });
  logger.info({ name, periodMs }, 'Interval job registered');
}

/**
 * One-shot delayed execution. Replaces any existing registration with the same name.
 */
export function registerTimeoutJob(
  name: string,
  delayMs: number,
  handler: () => void | Promise<void>
): void {
  unregister(name);
  const id = setTimeout(() => {
    registry.delete(name);
    void Promise.resolve(handler()).catch((err) => {
      logger.error({ name, err }, 'Delayed job failed');
    });
  }, delayMs);
  registry.set(name, {
    kind: 'timeout',
    name,
    stop: () => {
      clearTimeout(id);
      registry.delete(name);
    },
  });
}

/** Stops a single named job if it exists. */
export function stopScheduledJob(name: string): void {
  unregister(name);
}

/** Stops every job registered through this module (use on graceful shutdown). */
export function stopAllScheduledJobs(): void {
  const names = [...registry.keys()];
  for (const name of names) {
    unregister(name);
  }
  if (names.length > 0) {
    logger.info({ count: names.length }, 'Stopped all cron.service jobs');
  }
}

/** Debugging: current registered job names. */
export function listScheduledJobNames(): string[] {
  return [...registry.keys()];
}
