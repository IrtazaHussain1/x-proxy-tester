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

type JobKind = 'cron' | 'interval' | 'timeout';

type RegistryEntry = {
  kind: JobKind;
  name: string;
  stop: () => void;
};

export interface SchedulerJobStatus {
  job_id: string;
  description: string | null;
  kind: JobKind;
  configured_enabled: boolean;
  disabled_reason: string | null;
  cron_expression: string | null;
  cron_description: string | null;
  interval_ms: number | null;
  delay_ms: number | null;
  timezone: string | null;
  currently_running: boolean;
  last_run_started_at: string | null;
  last_run_ended_at: string | null;
  last_run_success_at: string | null;
  last_error: string | null;
  run_count: number;
}

export interface SchedulerHealthSnapshot {
  total_jobs: number;
  active_jobs: number;
  running_jobs: number;
  jobs: Record<string, SchedulerJobStatus>;
}

const registry = new Map<string, RegistryEntry>();
const schedulerState = new Map<string, SchedulerJobStatus>();

function nowIso(): string {
  return new Date().toISOString();
}

function truncateError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.length > 500 ? message.slice(0, 500) : message;
}

function intervalDescription(periodMs: number): string {
  if (periodMs % (60 * 60 * 1000) === 0) {
    const hours = periodMs / (60 * 60 * 1000);
    return hours === 1 ? 'Every hour' : `Every ${hours} hours`;
  }
  if (periodMs % (60 * 1000) === 0) {
    const minutes = periodMs / (60 * 1000);
    return minutes === 1 ? 'Every minute' : `Every ${minutes} minutes`;
  }
  if (periodMs % 1000 === 0) {
    const seconds = periodMs / 1000;
    return seconds === 1 ? 'Every second' : `Every ${seconds} seconds`;
  }
  return `Every ${periodMs} ms`;
}

function timeoutDescription(delayMs: number): string {
  if (delayMs % (60 * 1000) === 0) {
    const minutes = delayMs / (60 * 1000);
    return minutes === 1 ? 'Runs once after 1 minute' : `Runs once after ${minutes} minutes`;
  }
  if (delayMs % 1000 === 0) {
    const seconds = delayMs / 1000;
    return seconds === 1 ? 'Runs once after 1 second' : `Runs once after ${seconds} seconds`;
  }
  return `Runs once after ${delayMs} ms`;
}

function cronDescription(cronExpression: string, timezone: string): string | null {
  const parts = cronExpression.trim().split(/\s+/);
  if (parts.length !== 5) {
    return null;
  }

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
  if (minute === '*' && hour === '*' && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    return `Every minute (${timezone})`;
  }
  const everyMinutes = minute.match(/^\*\/(\d+)$/);
  if (everyMinutes && hour === '*' && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    return `Every ${everyMinutes[1]} minutes (${timezone})`;
  }
  if (/^\d+$/.test(minute) && hour === '*' && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    return `Hourly at minute ${minute.padStart(2, '0')} (${timezone})`;
  }
  const everyHours = hour.match(/^\*\/(\d+)$/);
  if (/^\d+$/.test(minute) && everyHours && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    return `Every ${everyHours[1]} hours at minute ${minute.padStart(2, '0')} (${timezone})`;
  }
  if (/^\d+$/.test(minute) && /^\d+$/.test(hour) && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    return `Daily at ${hour.padStart(2, '0')}:${minute.padStart(2, '0')} (${timezone})`;
  }
  return `Cron schedule ${cronExpression} (${timezone})`;
}

function upsertSchedulerState(
  name: string,
  patch: Partial<SchedulerJobStatus> & Pick<SchedulerJobStatus, 'job_id' | 'kind'>
): SchedulerJobStatus {
  const current = schedulerState.get(name);
  const next: SchedulerJobStatus = {
    job_id: patch.job_id ?? name,
    description: patch.description ?? current?.description ?? null,
    kind: patch.kind,
    configured_enabled: patch.configured_enabled ?? current?.configured_enabled ?? false,
    disabled_reason: patch.disabled_reason ?? current?.disabled_reason ?? null,
    cron_expression: patch.cron_expression ?? current?.cron_expression ?? null,
    cron_description: patch.cron_description ?? current?.cron_description ?? null,
    interval_ms: patch.interval_ms ?? current?.interval_ms ?? null,
    delay_ms: patch.delay_ms ?? current?.delay_ms ?? null,
    timezone: patch.timezone ?? current?.timezone ?? null,
    currently_running: patch.currently_running ?? current?.currently_running ?? false,
    last_run_started_at: patch.last_run_started_at ?? current?.last_run_started_at ?? null,
    last_run_ended_at: patch.last_run_ended_at ?? current?.last_run_ended_at ?? null,
    last_run_success_at: patch.last_run_success_at ?? current?.last_run_success_at ?? null,
    last_error: patch.last_error ?? current?.last_error ?? null,
    run_count: patch.run_count ?? current?.run_count ?? 0,
  };
  schedulerState.set(name, next);
  return next;
}

function instrumentHandler(
  name: string,
  kind: JobKind,
  handler: () => void | Promise<void>,
  options?: { disableAfterRun?: boolean }
): () => Promise<void> {
  return async () => {
    upsertSchedulerState(name, {
      job_id: name,
      kind,
      configured_enabled: true,
      disabled_reason: null,
      currently_running: true,
      last_run_started_at: nowIso(),
      last_run_ended_at: null,
    });
    try {
      await Promise.resolve(handler());
      const finishedAt = nowIso();
      upsertSchedulerState(name, {
        job_id: name,
        kind,
        currently_running: false,
        last_run_ended_at: finishedAt,
        last_run_success_at: finishedAt,
        last_error: null,
        run_count: (schedulerState.get(name)?.run_count ?? 0) + 1,
        configured_enabled: options?.disableAfterRun ? false : true,
        disabled_reason: options?.disableAfterRun ? 'completed' : null,
      });
    } catch (err) {
      upsertSchedulerState(name, {
        job_id: name,
        kind,
        currently_running: false,
        last_run_ended_at: nowIso(),
        last_error: truncateError(err),
        run_count: (schedulerState.get(name)?.run_count ?? 0) + 1,
        configured_enabled: options?.disableAfterRun ? false : true,
        disabled_reason: options?.disableAfterRun ? 'completed_with_error' : null,
      });
      throw err;
    }
  };
}

function markStopped(name: string, reason: string): void {
  const current = schedulerState.get(name);
  if (!current) return;
  upsertSchedulerState(name, {
    job_id: name,
    kind: current.kind,
    configured_enabled: false,
    disabled_reason: reason,
    currently_running: false,
  });
}

function unregister(name: string): void {
  const entry = registry.get(name);
  if (!entry) return;
  try {
    entry.stop();
  } catch (err) {
    logger.warn({ name, err }, 'Error stopping scheduled job');
  }
  registry.delete(name);
  markStopped(name, 'stopped');
}

export function markScheduledJobDisabled(
  name: string,
  options: {
    kind: JobKind;
    description?: string;
    disabledReason: string;
    cronExpression?: string;
    intervalMs?: number;
    delayMs?: number;
    timezone?: string;
  }
): void {
  const timezone = options.timezone ?? process.env.CRON_TZ ?? 'UTC';
  upsertSchedulerState(name, {
    job_id: name,
    kind: options.kind,
    description: options.description ?? null,
    configured_enabled: false,
    disabled_reason: options.disabledReason,
    cron_expression: options.cronExpression ?? null,
    cron_description: options.cronExpression
      ? cronDescription(options.cronExpression, timezone)
      : options.intervalMs != null
        ? intervalDescription(options.intervalMs)
        : options.delayMs != null
          ? timeoutDescription(options.delayMs)
          : null,
    interval_ms: options.intervalMs ?? null,
    delay_ms: options.delayMs ?? null,
    timezone: options.cronExpression ? timezone : null,
    currently_running: false,
  });
}

/**
 * Registers a cron task (5-field expression). Replaces any existing registration with the same name.
 */
export function registerCronJob(
  name: string,
  cronExpression: string,
  handler: () => void | Promise<void>,
  options?: { timezone?: string; description?: string }
): boolean {
  unregister(name);
  if (!cron.validate(cronExpression)) {
    upsertSchedulerState(name, {
      job_id: name,
      kind: 'cron',
      description: options?.description ?? null,
      configured_enabled: false,
      disabled_reason: 'invalid_cron_expression',
      cron_expression: cronExpression,
      cron_description: null,
      interval_ms: null,
      delay_ms: null,
      timezone: options?.timezone ?? process.env.CRON_TZ ?? 'UTC',
      currently_running: false,
    });
    logger.error({ name, cronExpression }, 'Invalid cron expression — job not registered');
    return false;
  }
  const timezone = options?.timezone ?? process.env.CRON_TZ ?? 'UTC';
  const wrappedHandler = instrumentHandler(name, 'cron', handler);
  const task = cron.schedule(
    cronExpression,
    () => {
      void wrappedHandler().catch((err) => {
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
  upsertSchedulerState(name, {
    job_id: name,
    kind: 'cron',
    description: options?.description ?? null,
    configured_enabled: true,
    disabled_reason: null,
    cron_expression: cronExpression,
    cron_description: cronDescription(cronExpression, timezone),
    interval_ms: null,
    delay_ms: null,
    timezone,
    currently_running: false,
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
  options?: { runImmediately?: boolean; description?: string }
): void {
  unregister(name);
  const wrappedHandler = instrumentHandler(name, 'interval', handler);
  if (options?.runImmediately) {
    void wrappedHandler().catch((err) => {
      logger.error({ name, err }, 'Interval job initial run failed');
    });
  }
  const id = setInterval(() => {
    void wrappedHandler().catch((err) => {
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
  upsertSchedulerState(name, {
    job_id: name,
    kind: 'interval',
    description: options?.description ?? null,
    configured_enabled: true,
    disabled_reason: null,
    cron_expression: null,
    cron_description: intervalDescription(periodMs),
    interval_ms: periodMs,
    delay_ms: null,
    timezone: null,
    currently_running: false,
  });
  logger.info({ name, periodMs }, 'Interval job registered');
}

/**
 * One-shot delayed execution. Replaces any existing registration with the same name.
 */
export function registerTimeoutJob(
  name: string,
  delayMs: number,
  handler: () => void | Promise<void>,
  options?: { description?: string }
): void {
  unregister(name);
  const wrappedHandler = instrumentHandler(name, 'timeout', handler, { disableAfterRun: true });
  const id = setTimeout(() => {
    registry.delete(name);
    void wrappedHandler().catch((err) => {
      logger.error({ name, err }, 'Delayed job failed');
    });
  }, delayMs);
  registry.set(name, {
    kind: 'timeout',
    name,
    stop: () => {
      clearTimeout(id);
      registry.delete(name);
      markStopped(name, 'stopped');
    },
  });
  upsertSchedulerState(name, {
    job_id: name,
    kind: 'timeout',
    description: options?.description ?? null,
    configured_enabled: true,
    disabled_reason: null,
    cron_expression: null,
    cron_description: timeoutDescription(delayMs),
    interval_ms: null,
    delay_ms: delayMs,
    timezone: null,
    currently_running: false,
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

export function getSchedulerHealthSnapshot(): SchedulerHealthSnapshot {
  const jobs = Object.fromEntries(
    [...schedulerState.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, status]) => [name, { ...status }])
  );
  const runningJobs = Object.values(jobs).filter((job) => job.currently_running).length;
  return {
    total_jobs: Object.keys(jobs).length,
    active_jobs: registry.size,
    running_jobs: runningJobs,
    jobs,
  };
}

export function resetSchedulerStateForTests(): void {
  stopAllScheduledJobs();
  schedulerState.clear();
}
