import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getSchedulerHealthSnapshot,
  markScheduledJobDisabled,
  registerIntervalJob,
  registerTimeoutJob,
  resetSchedulerStateForTests,
} from '../../src/services/cron.service';

afterEach(() => {
  resetSchedulerStateForTests();
  vi.useRealTimers();
});

describe('cron.service scheduler health', () => {
  it('reports disabled jobs with schedule metadata', () => {
    markScheduledJobDisabled('daily-aggregation', {
      kind: 'cron',
      description: 'Aggregates previous-day proxy request data into daily summary records.',
      disabledReason: 'env_flag_off',
      cronExpression: '0 1 * * *',
      timezone: 'UTC',
    });

    const snapshot = getSchedulerHealthSnapshot();
    const job = snapshot.jobs['daily-aggregation'];

    expect(snapshot.total_jobs).toBe(1);
    expect(snapshot.active_jobs).toBe(0);
    expect(job).toMatchObject({
      job_id: 'daily-aggregation',
      kind: 'cron',
      configured_enabled: false,
      disabled_reason: 'env_flag_off',
      cron_expression: '0 1 * * *',
    });
    expect(job.cron_description).toContain('Daily at 01:00');
  });

  it('tracks currently running interval jobs and clears state on success', async () => {
    let resolveRun!: () => void;
    const handler = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveRun = resolve;
        })
    );

    registerIntervalJob('duplicate-ip-snapshot-tick', 300000, handler, {
      runImmediately: true,
      description: 'Captures duplicate-IP snapshot rows for active and all proxy scopes.',
    });

    let snapshot = getSchedulerHealthSnapshot();
    expect(snapshot.running_jobs).toBe(1);
    expect(snapshot.jobs['duplicate-ip-snapshot-tick']).toMatchObject({
      configured_enabled: true,
      currently_running: true,
      interval_ms: 300000,
    });

    resolveRun();
    await Promise.resolve();
    await Promise.resolve();

    snapshot = getSchedulerHealthSnapshot();
    expect(snapshot.running_jobs).toBe(0);
    expect(snapshot.jobs['duplicate-ip-snapshot-tick']).toMatchObject({
      configured_enabled: true,
      currently_running: false,
      run_count: 1,
      last_error: null,
    });
    expect(snapshot.jobs['duplicate-ip-snapshot-tick'].last_run_success_at).not.toBeNull();
    expect(snapshot.jobs['duplicate-ip-snapshot-tick'].last_run_ended_at).not.toBeNull();
  });

  it('marks one-shot timeout jobs completed after execution', async () => {
    vi.useFakeTimers();
    const handler = vi.fn().mockResolvedValue(undefined);

    registerTimeoutJob('startup-daily-backfill', 60000, handler, {
      description: 'Runs a one-time startup backfill for recent daily aggregation windows.',
    });

    let snapshot = getSchedulerHealthSnapshot();
    expect(snapshot.jobs['startup-daily-backfill']).toMatchObject({
      configured_enabled: true,
      delay_ms: 60000,
      disabled_reason: null,
    });

    await vi.advanceTimersByTimeAsync(60000);

    snapshot = getSchedulerHealthSnapshot();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(snapshot.jobs['startup-daily-backfill']).toMatchObject({
      configured_enabled: false,
      disabled_reason: 'completed',
      currently_running: false,
      run_count: 1,
      last_error: null,
    });
    expect(snapshot.jobs['startup-daily-backfill'].last_run_success_at).not.toBeNull();
  });
});
