/**
 * Daily Aggregation Service
 *
 * Aggregates proxy request data by day into summary records.
 * Uses app-side streaming to avoid running heavy SQL on the DB server while
 * write workers are active. Rows are fetched in pages, metrics computed in
 * Node.js, then Prisma upserts run in configurable batches (`AGGREGATION_UPSERT_BATCH_SIZE`).
 *
 * @module services/daily-aggregation
 */

import { Prisma } from '@prisma/client';
import { computeServerLabelFromDeviceName } from '../helpers/server-name';
import { logger } from '../lib/logger';
import {
  backgroundDb as prisma,
  checkDatabaseHealth,
  hasDatabaseCapacityForBackgroundJobs,
  retryWithBackoff,
} from '../lib/db';
import { registerCronJob, stopScheduledJob } from './cron.service';

let isRunning = false;
let isAggregating = false;

// ---------------------------------------------------------------------------
// Job status tracking
// ---------------------------------------------------------------------------

export type AggregationJobStatus = 'success' | 'empty' | 'skipped' | 'failed';

export interface AggregationJobRun {
  status: AggregationJobStatus;
  /** Calendar day that was aggregated (YYYY-MM-DD). */
  day: string;
  /** Proxy rows upserted. 0 for non-success statuses. */
  upserted: number;
  /** Wall-clock duration of the run in milliseconds. */
  durationMs: number;
  /** Human-readable reason for skipped/failed status. */
  reason?: string;
  startedAt: string;
  finishedAt: string;
}

let lastAggregationRun: AggregationJobRun | null = null;

/** Returns the result of the most recent `aggregateDayInApp` call, or null if never run. */
export function getLastAggregationRun(): AggregationJobRun | null {
  return lastAggregationRun;
}

interface AggregateDayInAppOptions {
  skipIfAlreadyAggregated?: boolean;
}

interface AggregateRecentDaysOptions {
  skipAlreadyAggregatedDays?: boolean;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Returns the percentile value from a pre-sorted ascending array. */
function pct(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.max(0, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx] ?? null;
}

interface ProxyStats {
  total: number;
  success: number;
  timeout: number;
  connectionError: number;
  httpError: number;
  dnsError: number;
  rotation: number;
  responseTimes: number[];
  downloadSpeeds: number[];
  uploadSpeeds: number[];
  uniqueIps: Set<string>;
  previousOutboundIp: string | null;
  firstIp: string | null;
  lastIp: string | null;
  ipCounts: Map<string, number>;
  ipAssignments: string[];
  ipChanges: Array<{ from: string; to: string; at: string }>;
  inactiveRequestCount: number;
  wsDisconnectedCount: number;
  lastInactiveAt: Date | null;
}

function emptyStats(): ProxyStats {
  return {
    total: 0,
    success: 0,
    timeout: 0,
    connectionError: 0,
    httpError: 0,
    dnsError: 0,
    rotation: 0,
    responseTimes: [],
    downloadSpeeds: [],
    uploadSpeeds: [],
    uniqueIps: new Set(),
    previousOutboundIp: null,
    firstIp: null,
    lastIp: null,
    ipCounts: new Map(),
    ipAssignments: [],
    ipChanges: [],
    inactiveRequestCount: 0,
    wsDisconnectedCount: 0,
    lastInactiveAt: null,
  };
}

function accumulateRow(
  stats: ProxyStats,
  row: {
    status: string;
    responseTimeMs: number | null;
    downloadSpeedMbps: number | null;
    uploadSpeedMbps: number | null;
    outboundIp: string | null;
    timestamp: Date;
    proxyStatus: string | null;
    wsStatus: string | null;
  }
): void {
  stats.total++;
  if (row.proxyStatus !== null && row.proxyStatus !== 'active') {
    stats.inactiveRequestCount++;
    stats.lastInactiveAt = row.timestamp;
  }
  if (row.wsStatus !== null && row.wsStatus !== 'connected') {
    stats.wsDisconnectedCount++;
  }
  if (row.status === 'SUCCESS') {
    stats.success++;
  } else if (row.status === 'TIMEOUT') {
    stats.timeout++;
  } else if (row.status === 'CONNECTION_ERROR') {
    stats.connectionError++;
  } else if (row.status === 'HTTP_ERROR') {
    stats.httpError++;
  } else if (row.status === 'DNS_ERROR') {
    stats.dnsError++;
  }
  if (row.responseTimeMs !== null) stats.responseTimes.push(row.responseTimeMs);
  if (row.downloadSpeedMbps !== null) stats.downloadSpeeds.push(row.downloadSpeedMbps);
  if (row.uploadSpeedMbps !== null) stats.uploadSpeeds.push(row.uploadSpeedMbps);
  if (row.outboundIp) {
    stats.uniqueIps.add(row.outboundIp);
    stats.firstIp = stats.firstIp ?? row.outboundIp;
    stats.lastIp = row.outboundIp;
    stats.ipCounts.set(row.outboundIp, (stats.ipCounts.get(row.outboundIp) ?? 0) + 1);

    if (stats.previousOutboundIp === null || stats.previousOutboundIp !== row.outboundIp) {
      stats.ipAssignments.push(row.outboundIp);
    }
    if (stats.previousOutboundIp !== null && stats.previousOutboundIp !== row.outboundIp) {
      stats.ipChanges.push({
        from: stats.previousOutboundIp,
        to: row.outboundIp,
        at: row.timestamp.toISOString(),
      });
    }
    stats.previousOutboundIp = row.outboundIp;
  }
}

function avg(arr: number[]): number | null {
  if (arr.length === 0) return null;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function minOf(arr: number[]): number | null {
  return arr.length > 0 ? Math.min(...arr) : null;
}

function maxOf(arr: number[]): number | null {
  return arr.length > 0 ? Math.max(...arr) : null;
}

function getMostUsedIp(ipCounts: Map<string, number>): { ip: string | null; count: number } {
  let mostUsedIp: string | null = null;
  let mostUsedIpCount = 0;

  for (const [ip, count] of ipCounts.entries()) {
    if (count > mostUsedIpCount) {
      mostUsedIp = ip;
      mostUsedIpCount = count;
    }
  }

  return { ip: mostUsedIp, count: mostUsedIpCount };
}

/** Max retries for aggregation DB reads/writes (shared with hasColumn / batch flush). */
function aggregationQueryMaxRetries(): number {
  return Math.max(0, parseInt(process.env.AGGREGATION_QUERY_MAX_RETRIES ?? '5', 10) || 5);
}

/** True when `information_schema` reports the column exists (for mixed migration states). */
async function hasColumn(tableName: string, columnName: string): Promise<boolean> {
  if (!/^[a-z0-9_]+$/i.test(tableName) || !/^[a-z0-9_]+$/i.test(columnName)) {
    return false;
  }
  const rows = await retryWithBackoff(
    () =>
      prisma.$queryRaw<Array<{ cnt: bigint }>>(
        Prisma.sql`SELECT COUNT(*) AS cnt
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ${tableName}
        AND COLUMN_NAME = ${columnName}`
      ),
    `agg.hasColumn:${tableName}.${columnName}`,
    aggregationQueryMaxRetries()
  );
  return Number(rows[0]?.cnt ?? 0) > 0;
}

type RotationOutcomeAcc = {
  periodic: { success: number; failure: number };
  inactiveProxy: { success: number; failure: number };
};

/** Min / max / avg for positive speed samples in a day (matches prior SQL CASE filters). */
function reduceSpeedSamples(
  rows: Array<{ downloadSpeedMbps: number | null; uploadSpeedMbps: number | null }>
): {
  avgDl: number | null;
  maxDl: number | null;
  minDl: number | null;
  avgUl: number | null;
  maxUl: number | null;
  minUl: number | null;
} {
  const dl = rows.map((r) => r.downloadSpeedMbps).filter((v): v is number => v != null && v > 0);
  const ul = rows.map((r) => r.uploadSpeedMbps).filter((v): v is number => v != null && v > 0);
  const avg = (arr: number[]): number | null => (arr.length === 0 ? null : arr.reduce((s, x) => s + x, 0) / arr.length);
  return {
    avgDl: avg(dl),
    maxDl: dl.length ? Math.max(...dl) : null,
    minDl: dl.length ? Math.min(...dl) : null,
    avgUl: avg(ul),
    maxUl: ul.length ? Math.max(...ul) : null,
    minUl: ul.length ? Math.min(...ul) : null,
  };
}

async function fetchSpeedTestDayAggregates(
  proxyId: string,
  dayStart: Date,
  dayEnd: Date
): Promise<ReturnType<typeof reduceSpeedSamples>> {
  const rows = await prisma.speedTest.findMany({
    where: { proxyId, timestamp: { gte: dayStart, lt: dayEnd } },
    select: { downloadSpeedMbps: true, uploadSpeedMbps: true },
  });
  return reduceSpeedSamples(rows);
}

async function fetchRotationOutcomesForDay(
  proxyId: string,
  dayStart: Date,
  dayEnd: Date
): Promise<RotationOutcomeAcc> {
  const rows = await prisma.ipRotation.findMany({
    where: {
      proxyId,
      rotationTimestamp: { gte: dayStart, lt: dayEnd },
    },
    select: {
      success: true,
      cycle: { select: { cycleType: true } },
    },
  });
  const acc: RotationOutcomeAcc = {
    periodic:      { success: 0, failure: 0 },
    inactiveProxy: { success: 0, failure: 0 },
  };
  for (const r of rows) {
    const t = r.cycle?.cycleType;
    if (t === 'periodic') {
      if (r.success) acc.periodic.success++;
      else acc.periodic.failure++;
    } else if (t === 'inactive_proxy') {
      if (r.success) acc.inactiveProxy.success++;
      else acc.inactiveProxy.failure++;
    }
  }
  return acc;
}

async function fetchContinuousOutcomesForDay(
  proxyId: string,
  dayStart: Date,
  dayEnd: Date
): Promise<{ success: number; failure: number }> {
  const rows = await prisma.proxyRequest.groupBy({
    by: ['status'],
    where: {
      proxyId,
      source: 'continuous',
      timestamp: { gte: dayStart, lt: dayEnd },
    },
    _count: { _all: true },
  });
  let success = 0;
  let failure = 0;
  for (const r of rows) {
    const c = r._count._all;
    if (String(r.status).toLowerCase() === 'success') {
      success += c;
    } else {
      failure += c;
    }
  }
  return { success, failure };
}

function decimalOrNull(n: number | null, fractionDigits: number): Prisma.Decimal | null {
  if (n === null || !Number.isFinite(n)) {
    return null;
  }
  return new Prisma.Decimal(n.toFixed(fractionDigits));
}

type SummaryUpsertOp = {
  where: Prisma.ProxyRequestsDailySummaryWhereUniqueInput;
  create: Prisma.ProxyRequestsDailySummaryUncheckedCreateInput;
  update: Prisma.ProxyRequestsDailySummaryUncheckedUpdateInput;
};

/** Builds Prisma upsert args for one proxy-day summary row. */
function buildSummaryUpsertOp(input: {
  day: Date;
  proxyId: string;
  supportsExtendedDeviceMeta: boolean;
  summaryHasServerName: boolean;
  meta: {
    name: string;
    location: string | null;
    relayServerId: number | null;
    relayServerIpAddress: string | null;
  } | null;
  stats: ProxyStats;
  failure: number;
  successRatePct: number;
  ipDiversityScore: number;
  rotationCount: number;
  rotationOutcomes: RotationOutcomeAcc;
  continuousOutcomes: { success: number; failure: number };
  avgDl: number;
  avgUl: number;
  maxDl: number;
  maxUl: number;
  minDl: number;
  minUl: number;
  mostUsedIp: { ip: string | null; count: number };
  ipHistory: Prisma.InputJsonValue;
}): SummaryUpsertOp {
  const {
    day,
    proxyId,
    supportsExtendedDeviceMeta,
    summaryHasServerName,
    meta,
    stats,
    failure,
    successRatePct,
    ipDiversityScore,
    rotationCount,
    rotationOutcomes,
    continuousOutcomes,
    avgDl,
    avgUl,
    maxDl,
    maxUl,
    minDl,
    minUl,
    mostUsedIp,
    ipHistory,
  } = input;

  const deviceName = supportsExtendedDeviceMeta ? (meta?.name ?? null) : undefined;
  const serverLabel = computeServerLabelFromDeviceName(meta?.name);
  const serverName =
    supportsExtendedDeviceMeta && summaryHasServerName ? serverLabel : undefined;

  const baseScalars = {
    location: meta?.location ?? null,
    relayServerId: meta?.relayServerId != null ? String(meta.relayServerId) : null,
    relayServerIp: meta?.relayServerIpAddress ?? null,
    totalRequests: stats.total,
    successCount: stats.success,
    failureCount: failure,
    successRatePct: decimalOrNull(successRatePct, 2),
    avgResponseTimeMs: decimalOrNull(avg(stats.responseTimes), 2),
    minResponseTimeMs: minOf(stats.responseTimes),
    maxResponseTimeMs: maxOf(stats.responseTimes),
    p50ResponseTimeMs: pct(stats.responseTimes, 50),
    p95ResponseTimeMs: pct(stats.responseTimes, 95),
    p99ResponseTimeMs: pct(stats.responseTimes, 99),
    timeoutCount: stats.timeout,
    connectionErrorCount: stats.connectionError,
    httpErrorCount: stats.httpError,
    dnsErrorCount: stats.dnsError,
    rotationCount,
    ipRotationPeriodicSuccessCount: rotationOutcomes.periodic.success,
    ipRotationPeriodicFailureCount: rotationOutcomes.periodic.failure,
    ipRotationInactiveProxySuccessCount: rotationOutcomes.inactiveProxy.success,
    ipRotationInactiveProxyFailureCount: rotationOutcomes.inactiveProxy.failure,
    ipRotationContinuousSuccessCount: continuousOutcomes.success,
    ipRotationContinuousFailureCount: continuousOutcomes.failure,
    avgDownloadSpeedMbps: decimalOrNull(avgDl, 4),
    avgUploadSpeedMbps: decimalOrNull(avgUl, 4),
    maxDownloadSpeedMbps: decimalOrNull(maxDl, 4),
    maxUploadSpeedMbps: decimalOrNull(maxUl, 4),
    minDownloadSpeedMbps: decimalOrNull(minDl, 4),
    minUploadSpeedMbps: decimalOrNull(minUl, 4),
    uniqueIpsCount: stats.uniqueIps.size,
    ipDiversityScore: decimalOrNull(ipDiversityScore, 2),
    ipHistoryJson: ipHistory,
    ipChangeCount: rotationCount,
    firstIp: stats.firstIp,
    lastIp: stats.lastIp,
    mostUsedIp: mostUsedIp.ip,
    mostUsedIpCount: mostUsedIp.count,
    inactiveRequestCount: stats.inactiveRequestCount,
    inactiveRequestPct: decimalOrNull(
      stats.total > 0 ? (stats.inactiveRequestCount * 100) / stats.total : null,
      2
    ),
    lastInactiveAt: stats.lastInactiveAt,
    wsDisconnectedCount: stats.wsDisconnectedCount,
  } satisfies Prisma.ProxyRequestsDailySummaryUncheckedUpdateInput;

  const create: Prisma.ProxyRequestsDailySummaryUncheckedCreateInput = {
    day,
    proxyId,
    ...baseScalars,
    ...(deviceName !== undefined ? { deviceName } : {}),
    ...(serverName !== undefined ? { serverName } : {}),
  };

  const update: Prisma.ProxyRequestsDailySummaryUncheckedUpdateInput = {
    ...baseScalars,
    ...(deviceName !== undefined ? { deviceName } : {}),
    ...(serverName !== undefined ? { serverName } : {}),
  };

  return {
    where: { day_proxyId: { day, proxyId } },
    create,
    update,
  };
}

async function flushSummaryUpsertBatch(ops: SummaryUpsertOp[]): Promise<void> {
  if (ops.length === 0) {
    return;
  }
  await retryWithBackoff(
    () => prisma.$transaction(ops.map((op) => prisma.proxyRequestsDailySummary.upsert(op))),
    'agg.flushSummaryUpsertBatch',
    aggregationQueryMaxRetries()
  );
}

// ---------------------------------------------------------------------------
// App-side streaming aggregation (primary path)
// ---------------------------------------------------------------------------

const DEFAULT_PAGE_SIZE = 5_000;

/**
 * Aggregates a single calendar day entirely in Node.js.
 *
 * For each proxy that has rows on `day`:
 *  1. Streams proxy_requests in pages of PAGE_SIZE using the (proxyId, timestamp) index.
 *  2. Computes all summary metrics in memory.
 *  3. Upserts one row into proxy_requests_daily_summary.
 *
 * A configurable delay between proxy chunks (`AGGREGATION_PROXY_DELAY_MS`, default 50ms)
 * releases DB connections between pages so write workers can breathe.
 *
 * Transient DB errors on each query (groupBy, per-proxy pages, upsert batches, etc.) are retried
 * with exponential backoff (`AGGREGATION_QUERY_MAX_RETRIES`, default 5 — same semantics as `src/lib/db.ts`).
 *
 * Bounded concurrency is configurable via `AGGREGATION_PROXY_CONCURRENCY` (default 1).
 * Page size is configurable via `AGGREGATION_PROXY_REQUEST_PAGE_SIZE` (default 5000).
 *
 * @returns Number of proxy rows upserted.
 */
export async function aggregateDayInApp(
  day?: Date,
  options: AggregateDayInAppOptions = {}
): Promise<number> {
  if (isAggregating) {
    logger.warn('aggregateDayInApp already running, skipping');
    return 0;
  }

  const jobStartedAt = Date.now();
  const startedAtIso = new Date().toISOString();

  // Compute the day label early so all exit paths can record it.
  const earlyDay = new Date(day ?? Date.now() - 24 * 60 * 60 * 1000);
  earlyDay.setUTCHours(0, 0, 0, 0);
  const earlyDayLabel = earlyDay.toISOString().split('T')[0];

  function finish(
    status: AggregationJobStatus,
    upserted: number,
    dayStr: string,
    reason?: string
  ): number {
    lastAggregationRun = {
      status,
      day: dayStr,
      upserted,
      durationMs: Date.now() - jobStartedAt,
      reason,
      startedAt: startedAtIso,
      finishedAt: new Date().toISOString(),
    };
    return upserted;
  }

  const hasCapacity = await hasDatabaseCapacityForBackgroundJobs();
  if (!hasCapacity) {
    // Log at error so this surfaces in any alerting pipeline.
    // A skipped day is permanently lost once its partition is dropped (~30 days later).
    logger.error(
      { day: earlyDayLabel },
      'Daily aggregation SKIPPED — DB pool under pressure. This day will not be summarized unless backfilled manually via STARTUP_DAILY_BACKFILL_DAYS or scripts/run-aggregation.ts.'
    );
    return finish('skipped', 0, earlyDayLabel, 'DB pool under pressure');
  }

  const dbHealth = await checkDatabaseHealth();
  if (!dbHealth.connected) {
    logger.error('Database not connected, skipping daily aggregation');
    return finish('skipped', 0, earlyDayLabel, 'DB not connected');
  }

  const targetDay = day ?? new Date(Date.now() - 24 * 60 * 60 * 1000);
  const dayStart = new Date(targetDay);
  dayStart.setUTCHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
  const dayLabel = dayStart.toISOString().split('T')[0];

  const delayMs = Math.max(
    0,
    parseInt(process.env.AGGREGATION_PROXY_DELAY_MS ?? '50', 10) || 50
  );
  const proxyConcurrency = Math.max(
    1,
    parseInt(process.env.AGGREGATION_PROXY_CONCURRENCY ?? '1', 10) || 1
  );
  const proxyRequestPageSize = Math.max(
    1_000,
    parseInt(
      process.env.AGGREGATION_PROXY_REQUEST_PAGE_SIZE ?? String(DEFAULT_PAGE_SIZE),
      10
    ) || DEFAULT_PAGE_SIZE
  );

  isAggregating = true;
  // Watchdog: release the flag if the aggregation hangs (e.g. MySQL packet-level stall).
  // Without this, a single hung query permanently blocks all future runs.
  const WATCHDOG_MS = parseInt(process.env.AGGREGATION_WATCHDOG_MS ?? String(4 * 60 * 60 * 1000), 10);
  const watchdog = setTimeout(() => {
    logger.error(
      { day: dayLabel, watchdogMs: WATCHDOG_MS },
      'Aggregation watchdog triggered — query appears hung, releasing isAggregating lock'
    );
    isAggregating = false;
  }, WATCHDOG_MS);
  watchdog.unref();

  /** Proxies fully written this run; declared outside `try` so failure path reports partial progress. */
  let upserted = 0;
  const pendingSummaryOps: SummaryUpsertOp[] = [];
  let upsertedCount = 0;
  let writeQueue: Promise<void> = Promise.resolve();

  try {
    logger.info({ day: dayLabel }, 'Starting app-side daily aggregation');

    const aggRetries = aggregationQueryMaxRetries();
    const withAgg = <T>(label: string, fn: () => Promise<T>): Promise<T> =>
      retryWithBackoff(fn, label, aggRetries);

    // 1. Distinct proxies that have data for this day (partition-friendly range on timestamp).
    const proxyGroups = await withAgg('agg.proxyRequest.groupBy', () =>
      prisma.proxyRequest.groupBy({
        by: ['proxyId'],
        where: {
          timestamp: { gte: dayStart, lt: dayEnd },
        },
        _count: { _all: true },
      })
    );

    if (proxyGroups.length === 0) {
      const bounds = await withAgg('agg.proxyRequest.bounds', () =>
        prisma.proxyRequest.aggregate({
          _min: { timestamp: true },
          _max: { timestamp: true },
        })
      );
      logger.info(
        {
          day: dayLabel,
          windowUtc: { from: dayStart.toISOString(), to: dayEnd.toISOString() },
          proxyRequestsTableMinUtc: bounds._min.timestamp?.toISOString() ?? null,
          proxyRequestsTableMaxUtc: bounds._max.timestamp?.toISOString() ?? null,
        },
        'No proxy_requests in this UTC day window — compare windowUtc to your SQL range (aggregation uses UTC midnight, not server local DATE)'
      );
      return finish('empty', 0, dayLabel, 'no proxy_requests for day');
    }

    if (options.skipIfAlreadyAggregated) {
      const summaryCount = await withAgg('agg.proxyRequestsDailySummary.count', () =>
        prisma.proxyRequestsDailySummary.count({
          where: { day: dayStart },
        })
      );
      if (summaryCount >= proxyGroups.length) {
        logger.info(
          { day: dayLabel, summaryCount, proxyCount: proxyGroups.length },
          'Skipping aggregation for day because summary rows already cover all proxies'
        );
        return finish('skipped', 0, dayLabel, 'already aggregated');
      }
      logger.info(
        { day: dayLabel, summaryCount, proxyCount: proxyGroups.length },
        'Summary rows are incomplete for day, continuing aggregation'
      );
    }

    logger.info(
      {
        day: dayLabel,
        proxyCount: proxyGroups.length,
        proxyConcurrency,
        proxyRequestPageSize,
      },
      'Aggregating proxies'
    );

    const supportsDeviceName = await hasColumn('proxy_requests_daily_summary', 'device_name');
    const summaryHasServerName = await hasColumn('proxy_requests_daily_summary', 'server_name');
    const supportsExtendedDeviceMeta = supportsDeviceName;

    const supportsRotationTypeCounts = await hasColumn(
      'proxy_requests_daily_summary',
      'ip_rotation_periodic_success_count'
    );
    if (!supportsRotationTypeCounts) {
      logger.error(
        { day: dayLabel },
        'Skipping aggregation — ip_rotation_periodic_success_count column missing. ' +
        'Run: npx prisma migrate deploy  (migration 20260416093000_add_rotation_type_outcome_counts_to_daily_summary)'
      );
      return finish('skipped', 0, dayLabel, 'missing column: ip_rotation_periodic_success_count — run migrate deploy');
    }

    const supportsInactiveProxyCounts = await hasColumn(
      'proxy_requests_daily_summary',
      'ip_rotation_inactive_proxy_success_count'
    );
    if (!supportsInactiveProxyCounts) {
      logger.error(
        { day: dayLabel },
        'Skipping aggregation — ip_rotation_inactive_proxy_success_count column missing. ' +
        'Run: npx prisma migrate deploy  (migration 20260423000000_fix_rotation_continuous_columns)'
      );
      return finish('skipped', 0, dayLabel, 'missing column: ip_rotation_inactive_proxy_success_count — run migrate deploy');
    }

    const upsertBatchSize = Math.max(
      1,
      parseInt(process.env.AGGREGATION_UPSERT_BATCH_SIZE ?? '20', 10) || 20
    );
    const processProxy = async (
      proxyId: string
    ): Promise<{ op: SummaryUpsertOp | null; durationMs: number; proxyId: string }> => {
      const proxyStartedAt = Date.now();
      // 2. Proxy row (device display name drives server bucket via computeServerLabelFromDeviceName — not a DB column).
      const proxyRow = await withAgg(`agg.proxy.findUnique:${proxyId}`, () =>
        prisma.proxy.findUnique({
          where: { deviceId: proxyId },
          select: {
            name: true,
            location: true,
            relayServerId: true,
            relayServerIpAddress: true,
          },
        })
      );
      const meta =
        proxyRow === null
          ? null
          : {
              name: proxyRow.name,
              location: proxyRow.location,
              relayServerId: proxyRow.relayServerId,
              relayServerIpAddress: proxyRow.relayServerIpAddress,
            };

      // 3. Stream all rows for this proxy on this day via cursor-based pagination.
      //    Uses a composite (timestamp, id) cursor so that rows sharing the same
      //    millisecond timestamp at a page boundary are never skipped.
      //    Pure timestamp cursor (timestamp > ?) silently drops rows when the last
      //    row on page N shares its timestamp with the first row on page N+1.
      //    The (proxy_id, timestamp) index covers the leading timestamp > ? branch;
      //    the timestamp = ? AND id > ? branch does a bounded range scan.
      const stats = emptyStats();
      // Start cursor just before dayStart so the first page captures rows
      // with timestamp exactly equal to dayStart.
      let cursor = { timestamp: new Date(dayStart.getTime() - 1), id: '' };
      let proxyRequestPage = 0;

      while (true) {
        proxyRequestPage += 1;
        const rows = await withAgg(`agg.proxyRequest.page:${proxyId}:${proxyRequestPage}`, () =>
          prisma.proxyRequest.findMany({
            where: {
              proxyId,
              timestamp: { lt: dayEnd },
              OR: [
                { timestamp: { gt: cursor.timestamp } },
                {
                  AND: [
                    { timestamp: cursor.timestamp },
                    { id: { gt: cursor.id } },
                  ],
                },
              ],
            },
            orderBy: [{ timestamp: 'asc' }, { id: 'asc' }],
            take: proxyRequestPageSize,
            select: {
              id: true,
              status: true,
              responseTimeMs: true,
              downloadSpeedMbps: true,
              uploadSpeedMbps: true,
              outboundIp: true,
              timestamp: true,
              proxyStatus: true,
              wsStatus: true,
            },
          })
        );

        if (rows.length === 0) break;

        for (const row of rows) {
          accumulateRow(stats, {
            status: row.status,
            responseTimeMs: row.responseTimeMs,
            downloadSpeedMbps: row.downloadSpeedMbps,
            uploadSpeedMbps: row.uploadSpeedMbps,
            outboundIp: row.outboundIp,
            timestamp: row.timestamp,
            proxyStatus: row.proxyStatus ?? null,
            wsStatus: row.wsStatus ?? null,
          });
        }

        const lastRow = rows[rows.length - 1];
        cursor = { timestamp: lastRow.timestamp, id: lastRow.id };
        if (rows.length < proxyRequestPageSize) break;
      }

      if (stats.total === 0) return { op: null, durationMs: Date.now() - proxyStartedAt, proxyId };

      // 4a. Supporting day aggregates queried in parallel.
      const [spd, rotationOutcomes, continuousOutcomes] = await Promise.all([
        withAgg(`agg.speedTests:${proxyId}`, () =>
          fetchSpeedTestDayAggregates(proxyId, dayStart, dayEnd)
        ),
        withAgg(`agg.ipRotation:${proxyId}`, () =>
          fetchRotationOutcomesForDay(proxyId, dayStart, dayEnd)
        ),
        withAgg(`agg.continuous:${proxyId}`, () =>
          fetchContinuousOutcomesForDay(proxyId, dayStart, dayEnd)
        ),
      ]);
      const fromSpeedTests = {
        avgDl: spd.avgDl,
        maxDl: spd.maxDl,
        minDl: spd.minDl,
        avgUl: spd.avgUl,
        maxUl: spd.maxUl,
        minUl: spd.minUl,
      };

      const hasSpeedTestDay =
        fromSpeedTests.avgDl != null ||
        fromSpeedTests.maxDl != null ||
        fromSpeedTests.minDl != null ||
        fromSpeedTests.avgUl != null ||
        fromSpeedTests.maxUl != null ||
        fromSpeedTests.minUl != null;

      const avgDl = (hasSpeedTestDay ? fromSpeedTests.avgDl : avg(stats.downloadSpeeds)) ?? 0;
      const avgUl = (hasSpeedTestDay ? fromSpeedTests.avgUl : avg(stats.uploadSpeeds)) ?? 0;
      const maxDl = (hasSpeedTestDay ? fromSpeedTests.maxDl : maxOf(stats.downloadSpeeds)) ?? 0;
      const maxUl = (hasSpeedTestDay ? fromSpeedTests.maxUl : maxOf(stats.uploadSpeeds)) ?? 0;
      const minDl = (hasSpeedTestDay ? fromSpeedTests.minDl : minOf(stats.downloadSpeeds)) ?? 0;
      const minUl = (hasSpeedTestDay ? fromSpeedTests.minUl : minOf(stats.uploadSpeeds)) ?? 0;

      // 4. Compute derived metrics.
      stats.responseTimes.sort((a, b) => a - b);

      const failure = stats.total - stats.success;
      const successRatePct =
        stats.total > 0 ? parseFloat(((stats.success / stats.total) * 100).toFixed(2)) : 0;
      const ipDiversityScore =
        stats.total > 0
          ? parseFloat(((stats.uniqueIps.size / stats.total) * 100).toFixed(2))
          : 0;
      const mostUsedIp = getMostUsedIp(stats.ipCounts);
      const rotationCount = stats.ipChanges.length;

      const ipHistory: Prisma.InputJsonValue = {
        assignedIps: stats.ipAssignments,
        uniqueIps: Array.from(stats.uniqueIps),
        counts: Object.fromEntries(stats.ipCounts),
        changes: stats.ipChanges,
      };

      const op = buildSummaryUpsertOp({
        day: dayStart,
        proxyId,
        supportsExtendedDeviceMeta,
        summaryHasServerName,
        meta,
        stats,
        failure,
        successRatePct,
        ipDiversityScore,
        rotationCount,
        rotationOutcomes,
        continuousOutcomes,
        avgDl,
        avgUl,
        maxDl,
        maxUl,
        minDl,
        minUl,
        mostUsedIp,
        ipHistory,
      });
      return { op, durationMs: Date.now() - proxyStartedAt, proxyId };
    };

    let nextProxyIndex = 0;
    let processed = 0;
    const workerCount = Math.min(proxyConcurrency, proxyGroups.length);

    const enqueueWrite = async (result: {
      op: SummaryUpsertOp | null;
      durationMs: number;
      proxyId: string;
    }): Promise<void> => {
      writeQueue = writeQueue.then(async () => {
        processed += 1;
        if (result.op !== null) {
          pendingSummaryOps.push(result.op);
        }

        const reachedProgressBoundary = processed % 100 === 0 || processed === proxyGroups.length;
        const shouldFlush = pendingSummaryOps.length >= upsertBatchSize || reachedProgressBoundary;
        if (shouldFlush && pendingSummaryOps.length > 0) {
          const batch = pendingSummaryOps.splice(0, pendingSummaryOps.length);
          await flushSummaryUpsertBatch(batch);
          upsertedCount += batch.length;
        }

        logger.info(
          `Aggregation proxy completed day=${dayLabel} proxy=${processed}/${proxyGroups.length} proxyId=${result.proxyId} durationMs=${result.durationMs}`
        );
        if (reachedProgressBoundary) {
          logger.info(
            { day: dayLabel, processed, total: proxyGroups.length, upserted: upsertedCount },
            'Aggregation progress'
          );
        }
      });

      await writeQueue;
    };

    const runWorker = async (): Promise<void> => {
      while (true) {
        const currentIndex = nextProxyIndex;
        if (currentIndex >= proxyGroups.length) {
          return;
        }
        nextProxyIndex += 1;
        const proxyId = proxyGroups[currentIndex].proxyId;
        const result = await processProxy(proxyId);
        await enqueueWrite(result);
        if (delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }
    };

    await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
    await writeQueue;
    if (pendingSummaryOps.length > 0) {
      const batch = pendingSummaryOps.splice(0, pendingSummaryOps.length);
      await flushSummaryUpsertBatch(batch);
      upsertedCount += batch.length;
    }
    upserted = upsertedCount;

    logger.info({ day: dayLabel, upserted }, 'App-side daily aggregation completed');
    return finish('success', upserted, dayLabel);
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    try {
      await writeQueue;
      if (pendingSummaryOps.length > 0) {
        const batch = pendingSummaryOps.splice(0, pendingSummaryOps.length);
        await flushSummaryUpsertBatch(batch);
        upsertedCount += batch.length;
      }
      upserted = upsertedCount;
    } catch (flushError) {
      logger.error(
        {
          day: dayLabel,
          flushError: flushError instanceof Error ? flushError.message : String(flushError),
          pendingOps: pendingSummaryOps.length,
          upsertedBeforeFlushError: upsertedCount,
        },
        'Failed to flush pending aggregation rows after aggregation error'
      );
      upserted = upsertedCount;
    }
    logger.error(
      { error: errMsg, day: dayLabel, upsertedBeforeFailure: upserted },
      'App-side daily aggregation failed (upserted count is rows completed before this error; pending batch may be unflushed)'
    );
    return finish('failed', upserted, dayLabel, errMsg);
  } finally {
    clearTimeout(watchdog);
    isAggregating = false;
  }
}

// ---------------------------------------------------------------------------
// Legacy stored-procedure path (kept as a manual fallback)
// ---------------------------------------------------------------------------

/**
 * Aggregates a day via the MySQL stored procedure `aggregate_daily_summary`.
 * This is the old approach — kept for manual admin use or as a fallback when
 * the stored procedure is available. The scheduler now calls `aggregateDayInApp`.
 */
export async function aggregateDailySummary(day?: Date): Promise<number> {
  const hasCapacity = await hasDatabaseCapacityForBackgroundJobs();
  if (!hasCapacity) {
    logger.warn('Skipping daily aggregation tick due to database pool pressure');
    return 0;
  }

  const dbHealth = await checkDatabaseHealth();
  if (!dbHealth.connected) {
    logger.error('Database not connected, skipping daily aggregation');
    return 0;
  }

  const targetDay = day || new Date(Date.now() - 24 * 60 * 60 * 1000);
  const dayStart = new Date(targetDay);
  dayStart.setHours(0, 0, 0, 0);
  const dayDate = dayStart.toISOString().split('T')[0];

  try {
    logger.info({ day: dayDate }, 'Starting stored-proc daily aggregation');

    try {
      await prisma.$executeRaw(Prisma.sql`CALL aggregate_daily_summary(${dayDate})`);
    } catch (error: any) {
      if (error?.message?.includes('does not exist') || error?.code === '42000') {
        logger.warn('Stored procedure not found, falling back to aggregateDayInApp');
        return aggregateDayInApp(day);
      }
      throw error;
    }

    const proxyCount = await prisma.proxyRequestsDailySummary.count({
      where: { day: dayStart },
    });
    logger.info({ day: dayDate, proxyCount }, 'Stored-proc daily aggregation completed');
    return proxyCount;
  } catch (error) {
    logger.error(
      { error: error instanceof Error ? error.message : 'Unknown error', day: dayDate },
      'Failed to aggregate daily summary'
    );
    return 0;
  }
}

/**
 * Aggregates data for the last N days using app-side streaming.
 */
export async function aggregateRecentDays(
  days: number = 7,
  options: AggregateRecentDaysOptions = {}
): Promise<number> {
  let aggregated = 0;
  const now = new Date();

  for (let i = 1; i <= days; i++) {
    const day = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
    aggregated += await aggregateDayInApp(day, {
      skipIfAlreadyAggregated: options.skipAlreadyAggregatedDays,
    });
    if (i < days) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  logger.info({ days, aggregated }, 'Aggregated recent daily summaries');
  return aggregated;
}

/**
 * Rebuilds daily summary rows for each calendar day from start through end (inclusive).
 */
export async function aggregateDateRangeInclusive(start: Date, end: Date): Promise<number> {
  const startDay = new Date(start);
  startDay.setHours(0, 0, 0, 0);
  const endDay = new Date(end);
  endDay.setHours(0, 0, 0, 0);

  if (endDay < startDay) {
    logger.warn({ start: startDay, end: endDay }, 'aggregateDateRangeInclusive: end before start, skipping');
    return 0;
  }

  let total = 0;
  for (let d = new Date(startDay); d <= endDay; d.setDate(d.getDate() + 1)) {
    total += await aggregateDayInApp(new Date(d));
    if (d.getTime() < endDay.getTime()) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  logger.info(
    {
      from: startDay.toISOString().split('T')[0],
      to: endDay.toISOString().split('T')[0],
      total,
    },
    'Aggregated daily summaries for date range'
  );
  return total;
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

function parseAggregationSchedule(): { hour: number; minute: number } {
  const raw = process.env.AGGREGATION_SCHEDULE ?? '0 1 * * *';
  const parts = raw.trim().split(/\s+/);
  const minute = parseInt(parts[0] ?? '0', 10);
  const hour = parseInt(parts[1] ?? '1', 10);
  if (
    isNaN(minute) || minute < 0 || minute > 59 ||
    isNaN(hour)   || hour   < 0 || hour   > 23
  ) {
    logger.warn({ AGGREGATION_SCHEDULE: raw }, 'Invalid AGGREGATION_SCHEDULE, falling back to 01:00');
    return { hour: 1, minute: 0 };
  }
  return { hour, minute };
}

/**
 * Starts the daily aggregation service.
 * Uses app-side streaming aggregation — does NOT hold an exclusive DB lock,
 * so write workers are never blocked.
 */
export function startDailyAggregationService(): void {
  if (isRunning) {
    logger.warn('Daily aggregation service is already running');
    return;
  }

  isRunning = true;
  logger.info('Starting daily aggregation service (app-side streaming)');

  const { hour, minute } = parseAggregationSchedule();

  const schedule = `${minute} ${hour} * * *`;

  logger.info(
    {
      schedule,
      timezone: process.env.CRON_TZ ?? 'UTC',
    },
    'Scheduled daily aggregation'
  );

  registerCronJob(
    'daily-aggregation',
    schedule,
    async () => {
      await aggregateDayInApp();
      const run = lastAggregationRun;
      if (run) {
        const logFn = run.status === 'success' ? logger.info : run.status === 'empty' ? logger.info : logger.error;
        logFn(
          { status: run.status, day: run.day, upserted: run.upserted, durationMs: run.durationMs, reason: run.reason },
          `Daily aggregation job finished: ${run.status}`
        );
      }
    },
    {
      timezone: process.env.CRON_TZ ?? 'UTC',
      description: 'Aggregates previous-day proxy request data into daily summary records.',
    }
  );
}

/**
 * Stops the daily aggregation service.
 */
export function stopDailyAggregationService(): void {
  stopScheduledJob('daily-aggregation');
  isRunning = false;
  logger.info('Daily aggregation service stopped');
}
