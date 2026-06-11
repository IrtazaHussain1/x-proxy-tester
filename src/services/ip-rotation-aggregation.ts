/**
 * IP Rotation 6-Hour Aggregation Service
 *
 * Populates `ip_rotation_6h_summary` — one row per (bucketStart, proxyId, cycleType).
 * Buckets align to 00/06/12/18 UTC. BucketEnd is exclusive: [bucketStart, bucketEnd).
 *
 * Attribution logic (locked definitions from JE-446):
 *   commanded   — success=1 AND ip_after != ip_before (within a single row)
 *   same/stuck  — ip_before == ip_after
 *   failedButChanged — success=0 AND ip_after != ip_before
 *   auto/self   — cur.ip_before != prev.ip_after across consecutive rows (gap rule)
 *                 + cross-bucket: firstIpBefore != priorBucket.lastIpAfter
 *
 * @module services/ip-rotation-aggregation
 */

import { Prisma } from '@prisma/client';
import { computeServerLabelFromDeviceName } from '../helpers/server-name';
import { logger } from '../lib/logger';
import {
  backgroundDb,
  hasDatabaseCapacityForBackgroundJobs,
  retryWithBackoff,
} from '../lib/db';
import { registerIntervalJob, stopScheduledJob } from './cron.service';

// ---------------------------------------------------------------------------
// Bucket helpers (exported for unit tests)
// ---------------------------------------------------------------------------

const SIX_HOURS_MS = 6 * 3600 * 1000;

/** Aligns a Date to the floor of its 6-hour UTC bucket (00, 06, 12, 18). */
export function floorTo6h(date: Date): Date {
  return new Date(Math.floor(date.getTime() / SIX_HOURS_MS) * SIX_HOURS_MS);
}

// ---------------------------------------------------------------------------
// Pure computation helpers (exported for unit tests)
// ---------------------------------------------------------------------------

export type RotationRow = {
  ipBefore: string | null;
  ipAfter: string | null;
  success: boolean;
  rotationDurationMs: number | null;
  waitTimeMs: number | null;
  retryCount: number;
  statusBefore: string | null;
  wsStatusBefore: string | null;
  errorMessage: string | null;
};

export type AttributionCounts = {
  commandedIpChangeCount: number;
  sameIpCount: number;
  failedButIpChangedCount: number;
  /** Within-bucket auto-change only. Add boundary check separately. */
  autoIpChangeCountWithinBucket: number;
};

/** Compute per-row IP-change attribution for an ordered array of rotation rows. */
export function computeAttribution(rows: RotationRow[]): AttributionCounts {
  let commanded = 0;
  let same = 0;
  let failedChanged = 0;
  let auto = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const before = row.ipBefore;
    const after = row.ipAfter;

    if (before !== null && after !== null) {
      if (before === after) {
        same++;
      } else if (row.success) {
        commanded++;
      } else {
        failedChanged++;
      }
    }

    // Within-bucket row-gap: cur.ipBefore != prev.ipAfter
    if (i > 0) {
      const prev = rows[i - 1]!;
      if (prev.ipAfter !== null && before !== null && before !== prev.ipAfter) {
        auto++;
      }
    }
  }

  return {
    commandedIpChangeCount: commanded,
    sameIpCount: same,
    failedButIpChangedCount: failedChanged,
    autoIpChangeCountWithinBucket: auto,
  };
}

/** Classify distinct-IP count into a pool class. */
export function computePoolClass(distinctIpsBefore: number): string {
  if (distinctIpsBefore <= 1) return 'Stuck';
  if (distinctIpsBefore <= 5) return 'Cycling';
  if (distinctIpsBefore <= 20) return 'Medium';
  return 'Healthy';
}

/** Longest run of consecutive rows where ipBefore == ipAfter (IP did not change). */
export function computeMaxConsecutiveSameIp(rows: RotationRow[]): number {
  let max = 0;
  let run = 0;
  for (const row of rows) {
    if (row.ipBefore !== null && row.ipAfter !== null && row.ipBefore === row.ipAfter) {
      run++;
      if (run > max) max = run;
    } else {
      run = 0;
    }
  }
  return max;
}

/** p-th percentile (0–100) of a pre-sorted ascending array. Null if empty. */
export function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.max(0, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx] ?? null;
}

function avg(arr: number[]): number | null {
  if (arr.length === 0) return null;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function decimalOrNull(n: number | null, digits: number): Prisma.Decimal | null {
  if (n === null || !Number.isFinite(n)) return null;
  return new Prisma.Decimal(n.toFixed(digits));
}

// ---------------------------------------------------------------------------
// Raw DB row types
// ---------------------------------------------------------------------------

type RawRotationRow = {
  proxy_id: string;
  cycle_type: string;
  rotation_timestamp: Date;
  ip_before: string | null;
  ip_after: string | null;
  success: number | boolean;
  rotation_duration_ms: number | null;
  wait_time_ms: number | null;
  retry_count: number;
  status_before: string | null;
  ws_status_before: string | null;
  error_message: string | null;
  proxy_name: string | null;
  proxy_location: string | null;
  proxy_state: string | null;
  proxy_city: string | null;
};

// ---------------------------------------------------------------------------
// Core aggregation
// ---------------------------------------------------------------------------

const AGGREGATION_VERSION = 1;

/**
 * Aggregates all rotation rows in [bucketStart, bucketStart+6h) into
 * ip_rotation_6h_summary using an upsert per (bucketStart, proxyId, cycleType).
 *
 * @returns Number of rows upserted.
 */
export async function aggregateBucket(bucketStart: Date): Promise<number> {
  const bucketEnd = new Date(bucketStart.getTime() + SIX_HOURS_MS);
  const priorBucketStart = new Date(bucketStart.getTime() - SIX_HOURS_MS);
  const isComplete = bucketEnd <= new Date();

  const rows = await retryWithBackoff(
    () =>
      backgroundDb.$queryRaw<RawRotationRow[]>(
        Prisma.sql`
          SELECT
            ir.proxy_id,
            rc.cycle_type,
            ir.rotation_timestamp,
            ir.ip_before,
            ir.ip_after,
            ir.success,
            ir.rotation_duration_ms,
            ir.wait_time_ms,
            ir.retry_count,
            ir.status_before,
            ir.ws_status_before,
            ir.error_message,
            p.name       AS proxy_name,
            p.location   AS proxy_location,
            p.state      AS proxy_state,
            p.city       AS proxy_city
          FROM ip_rotations ir
          JOIN rotation_cycles rc ON ir.cycle_id = rc.id
          LEFT JOIN proxies p     ON p.device_id = ir.proxy_id
          WHERE ir.rotation_timestamp >= ${bucketStart}
            AND ir.rotation_timestamp <  ${bucketEnd}
          ORDER BY ir.proxy_id, rc.cycle_type, ir.rotation_timestamp
        `
      ),
    'ipRotationAgg.fetchBucket'
  );

  if (rows.length === 0) {
    logger.debug(
      { bucketStart: bucketStart.toISOString(), bucketEnd: bucketEnd.toISOString() },
      'ip-rotation-aggregation: no rows in bucket, skipping'
    );
    return 0;
  }

  // Group by (proxyId, cycleType)
  type GroupKey = string;
  const groups = new Map<GroupKey, RawRotationRow[]>();
  for (const row of rows) {
    const key = `${row.proxy_id}::${row.cycle_type}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(row);
  }

  // Batch-load prior bucket lastIpAfter for all (proxyId, cycleType) combos
  const priorRows = await retryWithBackoff(
    () =>
      backgroundDb.$queryRaw<Array<{ proxy_id: string; cycle_type: string; last_ip_after: string | null }>>(
        Prisma.sql`
          SELECT proxy_id, cycle_type, last_ip_after
          FROM ip_rotation_6h_summary
          WHERE bucket_start = ${priorBucketStart}
            AND proxy_id IN (${Prisma.join([...new Set(rows.map((r) => r.proxy_id))])})
        `
      ),
    'ipRotationAgg.fetchPriorBucket'
  );

  const priorMap = new Map<string, string | null>();
  for (const pr of priorRows) {
    priorMap.set(`${pr.proxy_id}::${pr.cycle_type}`, pr.last_ip_after);
  }

  let upserted = 0;

  for (const [key, groupRows] of groups.entries()) {
    const [proxyId, cycleType] = key.split('::') as [string, string];

    const rotationRows: RotationRow[] = groupRows.map((r) => ({
      ipBefore: r.ip_before,
      ipAfter: r.ip_after,
      success: Boolean(r.success),
      rotationDurationMs: r.rotation_duration_ms,
      waitTimeMs: r.wait_time_ms,
      retryCount: r.retry_count,
      statusBefore: r.status_before,
      wsStatusBefore: r.ws_status_before,
      errorMessage: r.error_message,
    }));

    const attempts = rotationRows.length;
    const successCount = rotationRows.filter((r) => r.success).length;
    const failedCount = attempts - successCount;
    const successRatePct = attempts > 0 ? (successCount * 100) / attempts : null;

    const attribution = computeAttribution(rotationRows);

    // Boundary auto-change
    const firstIpBefore = groupRows[0]?.ip_before ?? null;
    const lastIpAfter = groupRows[groupRows.length - 1]?.ip_after ?? null;
    const priorLastIpAfter = priorMap.get(key) ?? null;
    let boundaryAuto = 0;
    if (firstIpBefore !== null && priorLastIpAfter !== null && firstIpBefore !== priorLastIpAfter) {
      boundaryAuto = 1;
    }
    const autoIpChangeCount = attribution.autoIpChangeCountWithinBucket + boundaryAuto;

    const ipChangeTotal =
      attribution.commandedIpChangeCount + attribution.failedButIpChangedCount + autoIpChangeCount;
    const ipChangeRatePct = attempts > 0 ? (ipChangeTotal * 100) / attempts : null;
    const wastedRotationPct = attempts > 0 ? (attribution.sameIpCount * 100) / attempts : null;

    const distinctIpsBeforeSet = new Set(
      rotationRows.map((r) => r.ipBefore).filter((ip): ip is string => ip !== null)
    );
    const distinctIpsTotalSet = new Set([
      ...rotationRows.map((r) => r.ipBefore).filter((ip): ip is string => ip !== null),
      ...rotationRows.map((r) => r.ipAfter).filter((ip): ip is string => ip !== null),
    ]);
    const distinctIpsBefore = distinctIpsBeforeSet.size;
    const distinctIpsTotal = distinctIpsTotalSet.size;
    const rotationPoolClass = computePoolClass(distinctIpsBefore);
    const maxConsecutiveSameIp = computeMaxConsecutiveSameIp(rotationRows);

    const durations = rotationRows
      .map((r) => r.rotationDurationMs)
      .filter((v): v is number => v !== null)
      .sort((a, b) => a - b);
    const avgRotationDurationMs = avg(durations);
    const p95RotationDurationMs = percentile(durations, 95);
    const maxRotationDurationMs = durations.length > 0 ? durations[durations.length - 1]! : null;

    const waitTimes = rotationRows
      .map((r) => r.waitTimeMs)
      .filter((v): v is number => v !== null);
    const avgWaitTimeMs = avg(waitTimes);

    const totalRetryCount = rotationRows.reduce((s, r) => s + r.retryCount, 0);

    const preRotationAnomalyCount = rotationRows.filter(
      (r) =>
        (r.statusBefore !== null && r.statusBefore !== 'active') ||
        (r.wsStatusBefore !== null && r.wsStatusBefore !== 'connected')
    ).length;

    const distinctErrors = new Set(
      rotationRows.map((r) => r.errorMessage).filter((e): e is string => e !== null)
    );
    const distinctErrorCount = distinctErrors.size;
    const lastError =
      [...rotationRows].reverse().find((r) => r.errorMessage !== null)?.errorMessage ?? null;

    const anomalyRatePct = attempts > 0 ? (preRotationAnomalyCount * 100) / attempts : null;

    const firstRow = groupRows[0]!;
    const serverName = computeServerLabelFromDeviceName(firstRow.proxy_name);
    const deviceName = firstRow.proxy_name ?? null;
    const location = firstRow.proxy_location ?? null;
    const state = firstRow.proxy_state ?? null;
    const city = firstRow.proxy_city ?? null;

    const firstRotationAt = groupRows[0]!.rotation_timestamp;
    const lastRotationAt = groupRows[groupRows.length - 1]!.rotation_timestamp;

    // IP frequency map: ip_after → occurrence count, sorted desc, for per-proxy pool panel
    const ipFreqMap = new Map<string, number>();
    for (const r of rotationRows) {
      if (r.ipAfter !== null) ipFreqMap.set(r.ipAfter, (ipFreqMap.get(r.ipAfter) ?? 0) + 1);
    }
    const ipPoolSnapshot = JSON.stringify(
      [...ipFreqMap.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([ip, count]) => ({ ip, count }))
    );

    await retryWithBackoff(
      () =>
        backgroundDb.$executeRawUnsafe(
          `INSERT INTO ip_rotation_6h_summary
             (bucket_start, proxy_id, cycle_type, bucket_end,
              attempts, success_count, failed_count, success_rate_pct,
              commanded_ip_change_count, same_ip_count, failed_but_ip_changed_count, auto_ip_change_count,
              first_ip_before, last_ip_after,
              ip_change_total, ip_change_rate_pct, wasted_rotation_pct, anomaly_rate_pct,
              distinct_ips_before, distinct_ips_total, rotation_pool_class, max_consecutive_same_ip,
              avg_rotation_duration_ms, p95_rotation_duration_ms, max_rotation_duration_ms,
              avg_wait_time_ms, total_retry_count,
              pre_rotation_anomaly_count, distinct_error_count, last_error,
              server_name, device_name, location, state, city,
              first_rotation_at, last_rotation_at,
              is_complete, aggregation_version, ip_pool_snapshot,
              created_at, updated_at)
           VALUES (?, ?, ?, ?,
                   ?, ?, ?, ?,
                   ?, ?, ?, ?,
                   ?, ?,
                   ?, ?, ?, ?,
                   ?, ?, ?, ?,
                   ?, ?, ?,
                   ?, ?,
                   ?, ?, ?,
                   ?, ?, ?, ?, ?,
                   ?, ?,
                   ?, ?, ?,
                   NOW(), NOW())
           ON DUPLICATE KEY UPDATE
             bucket_end                    = VALUES(bucket_end),
             attempts                      = VALUES(attempts),
             success_count                 = VALUES(success_count),
             failed_count                  = VALUES(failed_count),
             success_rate_pct              = VALUES(success_rate_pct),
             commanded_ip_change_count     = VALUES(commanded_ip_change_count),
             same_ip_count                 = VALUES(same_ip_count),
             failed_but_ip_changed_count   = VALUES(failed_but_ip_changed_count),
             auto_ip_change_count          = VALUES(auto_ip_change_count),
             first_ip_before               = VALUES(first_ip_before),
             last_ip_after                 = VALUES(last_ip_after),
             ip_change_total               = VALUES(ip_change_total),
             ip_change_rate_pct            = VALUES(ip_change_rate_pct),
             wasted_rotation_pct           = VALUES(wasted_rotation_pct),
             anomaly_rate_pct              = VALUES(anomaly_rate_pct),
             distinct_ips_before           = VALUES(distinct_ips_before),
             distinct_ips_total            = VALUES(distinct_ips_total),
             rotation_pool_class           = VALUES(rotation_pool_class),
             max_consecutive_same_ip       = VALUES(max_consecutive_same_ip),
             avg_rotation_duration_ms      = VALUES(avg_rotation_duration_ms),
             p95_rotation_duration_ms      = VALUES(p95_rotation_duration_ms),
             max_rotation_duration_ms      = VALUES(max_rotation_duration_ms),
             avg_wait_time_ms              = VALUES(avg_wait_time_ms),
             total_retry_count             = VALUES(total_retry_count),
             pre_rotation_anomaly_count    = VALUES(pre_rotation_anomaly_count),
             distinct_error_count          = VALUES(distinct_error_count),
             last_error                    = VALUES(last_error),
             server_name                   = VALUES(server_name),
             device_name                   = VALUES(device_name),
             location                      = VALUES(location),
             state                         = VALUES(state),
             city                          = VALUES(city),
             first_rotation_at             = VALUES(first_rotation_at),
             last_rotation_at              = VALUES(last_rotation_at),
             is_complete                   = VALUES(is_complete),
             aggregation_version           = VALUES(aggregation_version),
             ip_pool_snapshot              = VALUES(ip_pool_snapshot),
             updated_at                    = NOW()`,
          bucketStart,
          proxyId,
          cycleType,
          bucketEnd,
          attempts,
          successCount,
          failedCount,
          decimalOrNull(successRatePct, 2),
          attribution.commandedIpChangeCount,
          attribution.sameIpCount,
          attribution.failedButIpChangedCount,
          autoIpChangeCount,
          firstIpBefore,
          lastIpAfter,
          ipChangeTotal,
          decimalOrNull(ipChangeRatePct, 2),
          decimalOrNull(wastedRotationPct, 2),
          decimalOrNull(anomalyRatePct, 2),
          distinctIpsBefore,
          distinctIpsTotal,
          rotationPoolClass,
          maxConsecutiveSameIp,
          decimalOrNull(avgRotationDurationMs, 2),
          p95RotationDurationMs,
          maxRotationDurationMs,
          decimalOrNull(avgWaitTimeMs, 2),
          totalRetryCount,
          preRotationAnomalyCount,
          distinctErrorCount,
          lastError,
          serverName,
          deviceName,
          location,
          state,
          city,
          firstRotationAt,
          lastRotationAt,
          isComplete ? 1 : 0,
          AGGREGATION_VERSION,
          ipPoolSnapshot
        ),
      `ipRotationAgg.upsert:${proxyId}:${cycleType}`
    );

    upserted++;
  }

  logger.debug(
    {
      bucketStart: bucketStart.toISOString(),
      groups: groups.size,
      upserted,
      rawRows: rows.length,
    },
    'ip-rotation-aggregation: bucket aggregated'
  );

  return upserted;
}

// ---------------------------------------------------------------------------
// Scheduled tick — catches prior complete bucket + current incomplete bucket
// ---------------------------------------------------------------------------

let isRunning = false;
let isTicking = false;

/**
 * Aggregates the previous complete 6h bucket and the current incomplete bucket.
 * Mirrors the 5-min aggregation's "prev + current" pattern.
 */
export async function aggregateRecentBuckets(): Promise<void> {
  if (isTicking) {
    logger.warn('ip-rotation-aggregation: already running, skipping tick');
    return;
  }

  if (!(await hasDatabaseCapacityForBackgroundJobs())) {
    logger.warn('ip-rotation-aggregation: DB pool under pressure, skipping tick');
    return;
  }

  isTicking = true;
  try {
    const now = new Date();
    const currentBucket = floorTo6h(now);
    const prevBucket = new Date(currentBucket.getTime() - SIX_HOURS_MS);

    let totalUpserted = 0;
    for (const bucket of [prevBucket, currentBucket]) {
      const n = await aggregateBucket(bucket);
      totalUpserted += n;
    }

    logger.info(
      {
        prevBucket: prevBucket.toISOString(),
        currentBucket: currentBucket.toISOString(),
        totalUpserted,
      },
      'ip-rotation-aggregation: tick completed'
    );
  } catch (error) {
    logger.error(
      { error: error instanceof Error ? error.message : String(error) },
      'ip-rotation-aggregation: tick failed'
    );
  } finally {
    isTicking = false;
  }
}

// ---------------------------------------------------------------------------
// Backfill
// ---------------------------------------------------------------------------

/**
 * Aggregates all 6h buckets from floorTo6h(startDate) through floorTo6h(endDate) inclusive.
 * Process in chronological order so boundary chaining (lastIpAfter) is correct.
 */
export async function aggregateBucketRange(startDate: Date, endDate: Date): Promise<number> {
  const start = floorTo6h(startDate);
  const end = floorTo6h(endDate);

  if (end < start) {
    logger.warn(
      { start: start.toISOString(), end: end.toISOString() },
      'ip-rotation-aggregation: aggregateBucketRange end before start, skipping'
    );
    return 0;
  }

  let total = 0;
  for (let bucket = new Date(start); bucket <= end; bucket = new Date(bucket.getTime() + SIX_HOURS_MS)) {
    total += await aggregateBucket(new Date(bucket));
    // Small yield between buckets to avoid monopolising the DB pool
    if (bucket.getTime() < end.getTime()) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  logger.info(
    {
      from: start.toISOString(),
      to: end.toISOString(),
      totalUpserted: total,
    },
    'ip-rotation-aggregation: range backfill completed'
  );
  return total;
}

// ---------------------------------------------------------------------------
// Scheduler wiring
// ---------------------------------------------------------------------------

const JOB_NAME = 'ip-rotation-aggregation';

/** Run ~5 min after each 6h boundary. Default: every 6h + 5min offset via interval. */
const DEFAULT_INTERVAL_MS = SIX_HOURS_MS;

/**
 * Starts the IP-rotation 6h aggregation service.
 * Call from main.ts after DB is confirmed healthy.
 */
export function startIpRotationAggregationService(): void {
  if (isRunning) {
    logger.warn('ip-rotation-aggregation: service already running');
    return;
  }

  isRunning = true;

  const intervalMs = parseInt(
    process.env.IP_ROTATION_AGGREGATION_INTERVAL_MS ?? String(DEFAULT_INTERVAL_MS),
    10
  ) || DEFAULT_INTERVAL_MS;

  registerIntervalJob(JOB_NAME, intervalMs, () => aggregateRecentBuckets(), {
    runImmediately: true,
    description: 'Aggregates ip_rotations into 6-hour summary buckets (ip_rotation_6h_summary).',
  });

  logger.info({ intervalMs }, 'ip-rotation-aggregation: service started');
}

/**
 * Stops the IP-rotation aggregation service.
 */
export function stopIpRotationAggregationService(): void {
  stopScheduledJob(JOB_NAME);
  isRunning = false;
  logger.info('ip-rotation-aggregation: service stopped');
}
