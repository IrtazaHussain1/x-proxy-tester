/**
 * Daily Aggregation Service
 *
 * Aggregates proxy request data by day into summary records.
 * Uses app-side streaming to avoid running heavy SQL on the DB server while
 * write workers are active. Rows are fetched in pages, metrics computed in
 * Node.js, then a single upsert is issued per proxy per day.
 *
 * @module services/daily-aggregation
 */

import { logger } from '../lib/logger';
import { backgroundDb as prisma } from '../lib/db';
import { checkDatabaseHealth } from '../lib/db';
import { hasDatabaseCapacityForBackgroundJobs } from '../lib/db';
import { computeServerLabelFromDeviceName } from '../helpers/server-name';
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
  }
): void {
  stats.total++;
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

/** Normalize MySQL decimal / bigint from raw query to number | null. */
function sqlNumber(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const x = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(x) ? x : null;
}

async function hasColumn(tableName: string, columnName: string): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<Array<{ cnt: bigint }>>(
    `SELECT COUNT(*) AS cnt
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
        AND COLUMN_NAME = ?`,
    tableName,
    columnName
  );
  return Number(rows[0]?.cnt ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// App-side streaming aggregation (primary path)
// ---------------------------------------------------------------------------

const PAGE_SIZE = 5_000;

/**
 * Aggregates a single calendar day entirely in Node.js.
 *
 * For each proxy that has rows on `day`:
 *  1. Streams proxy_requests in pages of PAGE_SIZE using the (proxyId, timestamp) index.
 *  2. Computes all summary metrics in memory.
 *  3. Upserts one row into proxy_requests_daily_summary.
 *
 * A configurable delay between proxies (`AGGREGATION_PROXY_DELAY_MS`, default 50ms)
 * releases DB connections between pages so write workers can breathe.
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

  try {
    logger.info({ day: dayLabel }, 'Starting app-side daily aggregation');

    // 1. Distinct proxies that have data for this day.
    //    Uses the partition-pruning-friendly range predicate.
    const proxyRows = await prisma.$queryRawUnsafe<Array<{ proxy_id: string }>>(
      `SELECT DISTINCT proxy_id
         FROM proxy_requests
        WHERE timestamp >= ?
          AND timestamp <  ?`,
      dayStart,
      dayEnd
    );

    if (proxyRows.length === 0) {
      logger.info({ day: dayLabel }, 'No proxy_requests found for day, skipping aggregation');
      return finish('empty', 0, dayLabel, 'no proxy_requests for day');
    }

    if (options.skipIfAlreadyAggregated) {
      const summaryRows = await prisma.$queryRawUnsafe<Array<{ cnt: bigint }>>(
        `SELECT COUNT(*) AS cnt
           FROM proxy_requests_daily_summary
          WHERE day = ?`,
        dayLabel
      );
      const summaryCount = Number(summaryRows[0]?.cnt ?? 0);
      if (summaryCount >= proxyRows.length) {
        logger.info(
          { day: dayLabel, summaryCount, proxyCount: proxyRows.length },
          'Skipping aggregation for day because summary rows already cover all proxies'
        );
        return finish('skipped', 0, dayLabel, 'already aggregated');
      }
      logger.info(
        { day: dayLabel, summaryCount, proxyCount: proxyRows.length },
        'Summary rows are incomplete for day, continuing aggregation'
      );
    }

    logger.info({ day: dayLabel, proxyCount: proxyRows.length }, 'Aggregating proxies');

    const supportsDeviceName = await hasColumn('proxy_requests_daily_summary', 'device_name');
    const supportsServerName = await hasColumn('proxy_requests_daily_summary', 'server_name');
    const supportsExtendedDeviceMeta = supportsDeviceName && supportsServerName;

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

    let upserted = 0;

    for (const { proxy_id: proxyId } of proxyRows) {
      // 2. Fetch proxy metadata (location, relay server info).
      const proxyMeta = await prisma.$queryRawUnsafe<Array<{
        name: string | null;
        location: string | null;
        relay_server_id: number | null;
        relay_server_ip_address: string | null;
      }>>(
        `SELECT name, location, relay_server_id, relay_server_ip_address
           FROM proxies WHERE device_id = ? LIMIT 1`,
        proxyId
      );
      const meta = proxyMeta[0] ?? null;

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

      while (true) {
        const rows = await prisma.$queryRawUnsafe<Array<{
          id: string;
          status: string;
          response_time_ms: number | null;
          ip_changed: number | boolean;
          download_speed_mbps: number | null;
          upload_speed_mbps: number | null;
          outbound_ip: string | null;
          timestamp: Date;
        }>>(
          `SELECT id, status, response_time_ms, ip_changed,
                  download_speed_mbps, upload_speed_mbps, outbound_ip, timestamp
             FROM proxy_requests
            WHERE proxy_id = ?
              AND (timestamp > ? OR (timestamp = ? AND id > ?))
              AND timestamp < ?
            ORDER BY timestamp ASC, id ASC
            LIMIT ?`,
          proxyId, cursor.timestamp, cursor.timestamp, cursor.id, dayEnd, PAGE_SIZE
        );

        if (rows.length === 0) break;

        for (const row of rows) {
          accumulateRow(stats, {
            status: row.status,
            responseTimeMs: row.response_time_ms,
            downloadSpeedMbps: row.download_speed_mbps,
            uploadSpeedMbps: row.upload_speed_mbps,
            outboundIp: row.outbound_ip,
            timestamp: row.timestamp,
          });
        }

        // Advance composite cursor to the last row of this page.
        const lastRow = rows[rows.length - 1];
        cursor = { timestamp: lastRow.timestamp, id: lastRow.id };
        if (rows.length < PAGE_SIZE) break;
      }

      if (stats.total === 0) continue;

      // 4a. Speed metrics from speed_tests (authoritative).
      //     Continuous tests leave proxy_requests.download_speed_mbps / upload_speed_mbps NULL;
      //     speed-test-service writes to speed_tests only.
      //     Use conditional aggregates so rows with only download or only upload success still contribute.
      const speedRows = await prisma.$queryRawUnsafe<Array<{
        avg_download: unknown;
        max_download: unknown;
        min_download: unknown;
        avg_upload: unknown;
        max_upload: unknown;
        min_upload: unknown;
      }>>(
        `SELECT
           AVG(CASE WHEN download_speed_mbps IS NOT NULL AND download_speed_mbps > 0
                    THEN download_speed_mbps END) AS avg_download,
           MAX(CASE WHEN download_speed_mbps IS NOT NULL AND download_speed_mbps > 0
                    THEN download_speed_mbps END) AS max_download,
           MIN(CASE WHEN download_speed_mbps IS NOT NULL AND download_speed_mbps > 0
                    THEN download_speed_mbps END) AS min_download,
           AVG(CASE WHEN upload_speed_mbps IS NOT NULL AND upload_speed_mbps > 0
                    THEN upload_speed_mbps END) AS avg_upload,
           MAX(CASE WHEN upload_speed_mbps IS NOT NULL AND upload_speed_mbps > 0
                    THEN upload_speed_mbps END) AS max_upload,
           MIN(CASE WHEN upload_speed_mbps IS NOT NULL AND upload_speed_mbps > 0
                    THEN upload_speed_mbps END) AS min_upload
         FROM speed_tests
        WHERE proxy_id = ?
          AND timestamp >= ?
          AND timestamp < ?`,
        proxyId, dayStart, dayEnd
      );
      const rawSpd = speedRows[0] ?? null;

      const fromSpeedTests = rawSpd
        ? {
            avgDl: sqlNumber(rawSpd.avg_download),
            maxDl: sqlNumber(rawSpd.max_download),
            minDl: sqlNumber(rawSpd.min_download),
            avgUl: sqlNumber(rawSpd.avg_upload),
            maxUl: sqlNumber(rawSpd.max_upload),
            minUl: sqlNumber(rawSpd.min_upload),
          }
        : null;

      const hasSpeedTestDay =
        fromSpeedTests &&
        (fromSpeedTests.avgDl != null ||
          fromSpeedTests.maxDl != null ||
          fromSpeedTests.minDl != null ||
          fromSpeedTests.avgUl != null ||
          fromSpeedTests.maxUl != null ||
          fromSpeedTests.minUl != null);

      const avgDl = (hasSpeedTestDay ? fromSpeedTests!.avgDl : avg(stats.downloadSpeeds)) ?? 0;
      const avgUl = (hasSpeedTestDay ? fromSpeedTests!.avgUl : avg(stats.uploadSpeeds)) ?? 0;
      const maxDl = (hasSpeedTestDay ? fromSpeedTests!.maxDl : maxOf(stats.downloadSpeeds)) ?? 0;
      const maxUl = (hasSpeedTestDay ? fromSpeedTests!.maxUl : maxOf(stats.uploadSpeeds)) ?? 0;
      const minDl = (hasSpeedTestDay ? fromSpeedTests!.minDl : minOf(stats.downloadSpeeds)) ?? 0;
      const minUl = (hasSpeedTestDay ? fromSpeedTests!.minUl : minOf(stats.uploadSpeeds)) ?? 0;

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
      const rotationOutcomeRows = await prisma.$queryRawUnsafe<Array<{
        rotation_group: string;
        success_count: unknown;
        failure_count: unknown;
      }>>(
        `SELECT
           CASE
             WHEN rc.cycle_type = 'periodic' THEN 'periodic'
             ELSE 'continuous'
           END AS rotation_group,
           SUM(CASE WHEN ir.success = true THEN 1 ELSE 0 END) AS success_count,
           SUM(CASE WHEN ir.success = false THEN 1 ELSE 0 END) AS failure_count
         FROM ip_rotations ir
         JOIN rotation_cycles rc ON rc.id = ir.cycle_id
         WHERE ir.proxy_id = ?
           AND ir.rotation_timestamp >= ?
           AND ir.rotation_timestamp < ?
         GROUP BY
           CASE
             WHEN rc.cycle_type = 'periodic' THEN 'periodic'
             ELSE 'continuous'
           END`,
        proxyId, dayStart, dayEnd
      );
      const rotationOutcomes = rotationOutcomeRows.reduce(
        (acc, row) => {
          const key = row.rotation_group === 'periodic' ? 'periodic' : 'continuous';
          const successCount = sqlNumber(row.success_count) ?? 0;
          const failureCount = sqlNumber(row.failure_count) ?? 0;
          acc[key].success += successCount;
          acc[key].failure += failureCount;
          return acc;
        },
        {
          periodic: { success: 0, failure: 0 },
          continuous: { success: 0, failure: 0 },
        }
      );
      const deviceName = meta?.name ?? null;
      const serverName = computeServerLabelFromDeviceName(deviceName);
      const ipHistoryJson = JSON.stringify({
        assignedIps: stats.ipAssignments,
        uniqueIps: Array.from(stats.uniqueIps),
        counts: Object.fromEntries(stats.ipCounts),
        changes: stats.ipChanges,
      });

      // 5. Upsert via raw SQL (INSERT ... ON DUPLICATE KEY UPDATE) so this
      //    works regardless of whether the Prisma client has been regenerated.
      const dayStr = dayStart.toISOString().split('T')[0];
      const insertSql = supportsExtendedDeviceMeta
        ? `INSERT INTO proxy_requests_daily_summary (
           day, proxy_id, device_name, server_name, location, relay_server_id, relay_server_ip,
           total_requests, success_count, failure_count, success_rate_pct,
           avg_response_time_ms, min_response_time_ms, max_response_time_ms,
           p50_response_time_ms, p95_response_time_ms, p99_response_time_ms,
           timeout_count, connection_error_count, http_error_count, dns_error_count,
           rotation_count,
           ip_rotation_periodic_success_count, ip_rotation_periodic_failure_count,
           ip_rotation_continuous_success_count, ip_rotation_continuous_failure_count,
           avg_download_speed_mbps, avg_upload_speed_mbps,
           max_download_speed_mbps, max_upload_speed_mbps,
           min_download_speed_mbps, min_upload_speed_mbps,
           unique_ips_count, ip_diversity_score,
           ip_history_json, ip_change_count, first_ip, last_ip, most_used_ip, most_used_ip_count,
           created_at, updated_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NOW(),NOW())
         ON DUPLICATE KEY UPDATE
           device_name           = VALUES(device_name),
           server_name           = VALUES(server_name),
           location              = VALUES(location),
           relay_server_id       = VALUES(relay_server_id),
           relay_server_ip       = VALUES(relay_server_ip),
           total_requests        = VALUES(total_requests),
           success_count         = VALUES(success_count),
           failure_count         = VALUES(failure_count),
           success_rate_pct      = VALUES(success_rate_pct),
           avg_response_time_ms  = VALUES(avg_response_time_ms),
           min_response_time_ms  = VALUES(min_response_time_ms),
           max_response_time_ms  = VALUES(max_response_time_ms),
           p50_response_time_ms  = VALUES(p50_response_time_ms),
           p95_response_time_ms  = VALUES(p95_response_time_ms),
           p99_response_time_ms  = VALUES(p99_response_time_ms),
           timeout_count         = VALUES(timeout_count),
           connection_error_count= VALUES(connection_error_count),
           http_error_count      = VALUES(http_error_count),
           dns_error_count       = VALUES(dns_error_count),
           rotation_count        = VALUES(rotation_count),
           ip_rotation_periodic_success_count = VALUES(ip_rotation_periodic_success_count),
           ip_rotation_periodic_failure_count = VALUES(ip_rotation_periodic_failure_count),
           ip_rotation_continuous_success_count = VALUES(ip_rotation_continuous_success_count),
           ip_rotation_continuous_failure_count = VALUES(ip_rotation_continuous_failure_count),
           avg_download_speed_mbps = VALUES(avg_download_speed_mbps),
           avg_upload_speed_mbps   = VALUES(avg_upload_speed_mbps),
           max_download_speed_mbps = VALUES(max_download_speed_mbps),
           max_upload_speed_mbps   = VALUES(max_upload_speed_mbps),
           min_download_speed_mbps = VALUES(min_download_speed_mbps),
           min_upload_speed_mbps   = VALUES(min_upload_speed_mbps),
           unique_ips_count      = VALUES(unique_ips_count),
           ip_diversity_score    = VALUES(ip_diversity_score),
           ip_history_json       = VALUES(ip_history_json),
           ip_change_count       = VALUES(ip_change_count),
           first_ip              = VALUES(first_ip),
           last_ip               = VALUES(last_ip),
           most_used_ip          = VALUES(most_used_ip),
           most_used_ip_count    = VALUES(most_used_ip_count),
           updated_at            = CURRENT_TIMESTAMP`
        : `INSERT INTO proxy_requests_daily_summary (
           day, proxy_id, location, relay_server_id, relay_server_ip,
           total_requests, success_count, failure_count, success_rate_pct,
           avg_response_time_ms, min_response_time_ms, max_response_time_ms,
           p50_response_time_ms, p95_response_time_ms, p99_response_time_ms,
           timeout_count, connection_error_count, http_error_count, dns_error_count,
           rotation_count,
           ip_rotation_periodic_success_count, ip_rotation_periodic_failure_count,
           ip_rotation_continuous_success_count, ip_rotation_continuous_failure_count,
           avg_download_speed_mbps, avg_upload_speed_mbps,
           max_download_speed_mbps, max_upload_speed_mbps,
           min_download_speed_mbps, min_upload_speed_mbps,
           unique_ips_count, ip_diversity_score,
           ip_history_json, ip_change_count, first_ip, last_ip, most_used_ip, most_used_ip_count,
           created_at, updated_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NOW(),NOW())
         ON DUPLICATE KEY UPDATE
           location              = VALUES(location),
           relay_server_id       = VALUES(relay_server_id),
           relay_server_ip       = VALUES(relay_server_ip),
           total_requests        = VALUES(total_requests),
           success_count         = VALUES(success_count),
           failure_count         = VALUES(failure_count),
           success_rate_pct      = VALUES(success_rate_pct),
           avg_response_time_ms  = VALUES(avg_response_time_ms),
           min_response_time_ms  = VALUES(min_response_time_ms),
           max_response_time_ms  = VALUES(max_response_time_ms),
           p50_response_time_ms  = VALUES(p50_response_time_ms),
           p95_response_time_ms  = VALUES(p95_response_time_ms),
           p99_response_time_ms  = VALUES(p99_response_time_ms),
           timeout_count         = VALUES(timeout_count),
           connection_error_count= VALUES(connection_error_count),
           http_error_count      = VALUES(http_error_count),
           dns_error_count       = VALUES(dns_error_count),
           rotation_count        = VALUES(rotation_count),
           ip_rotation_periodic_success_count = VALUES(ip_rotation_periodic_success_count),
           ip_rotation_periodic_failure_count = VALUES(ip_rotation_periodic_failure_count),
           ip_rotation_continuous_success_count = VALUES(ip_rotation_continuous_success_count),
           ip_rotation_continuous_failure_count = VALUES(ip_rotation_continuous_failure_count),
           avg_download_speed_mbps = VALUES(avg_download_speed_mbps),
           avg_upload_speed_mbps   = VALUES(avg_upload_speed_mbps),
           max_download_speed_mbps = VALUES(max_download_speed_mbps),
           max_upload_speed_mbps   = VALUES(max_upload_speed_mbps),
           min_download_speed_mbps = VALUES(min_download_speed_mbps),
           min_upload_speed_mbps   = VALUES(min_upload_speed_mbps),
           unique_ips_count      = VALUES(unique_ips_count),
           ip_diversity_score    = VALUES(ip_diversity_score),
           ip_history_json       = VALUES(ip_history_json),
           ip_change_count       = VALUES(ip_change_count),
           first_ip              = VALUES(first_ip),
           last_ip               = VALUES(last_ip),
           most_used_ip          = VALUES(most_used_ip),
           most_used_ip_count    = VALUES(most_used_ip_count),
           updated_at            = CURRENT_TIMESTAMP`;

      const params = supportsExtendedDeviceMeta
        ? [
            dayStr, proxyId, deviceName, serverName,
            meta?.location ?? null,
            meta?.relay_server_id != null ? String(meta.relay_server_id) : null,
            meta?.relay_server_ip_address ?? null,
            stats.total, stats.success, failure, successRatePct,
            avg(stats.responseTimes), minOf(stats.responseTimes), maxOf(stats.responseTimes),
            pct(stats.responseTimes, 50), pct(stats.responseTimes, 95), pct(stats.responseTimes, 99),
            stats.timeout, stats.connectionError, stats.httpError, stats.dnsError,
            rotationCount,
            rotationOutcomes.periodic.success, rotationOutcomes.periodic.failure,
            rotationOutcomes.continuous.success, rotationOutcomes.continuous.failure,
            avgDl, avgUl, maxDl, maxUl, minDl, minUl,
            stats.uniqueIps.size, ipDiversityScore,
            ipHistoryJson, rotationCount, stats.firstIp, stats.lastIp, mostUsedIp.ip, mostUsedIp.count
          ]
        : [
            dayStr, proxyId,
            meta?.location ?? null,
            meta?.relay_server_id != null ? String(meta.relay_server_id) : null,
            meta?.relay_server_ip_address ?? null,
            stats.total, stats.success, failure, successRatePct,
            avg(stats.responseTimes), minOf(stats.responseTimes), maxOf(stats.responseTimes),
            pct(stats.responseTimes, 50), pct(stats.responseTimes, 95), pct(stats.responseTimes, 99),
            stats.timeout, stats.connectionError, stats.httpError, stats.dnsError,
            rotationCount,
            rotationOutcomes.periodic.success, rotationOutcomes.periodic.failure,
            rotationOutcomes.continuous.success, rotationOutcomes.continuous.failure,
            avgDl, avgUl, maxDl, maxUl, minDl, minUl,
            stats.uniqueIps.size, ipDiversityScore,
            ipHistoryJson, rotationCount, stats.firstIp, stats.lastIp, mostUsedIp.ip, mostUsedIp.count
          ];

      await prisma.$executeRawUnsafe(insertSql, ...params);

      upserted++;

      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }

    logger.info({ day: dayLabel, upserted }, 'App-side daily aggregation completed');
    return finish('success', upserted, dayLabel);
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.error(
      { error: errMsg, day: dayLabel },
      'App-side daily aggregation failed'
    );
    return finish('failed', 0, dayLabel, errMsg);
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
      await prisma.$executeRawUnsafe(`CALL aggregate_daily_summary(?)`, dayDate);
    } catch (error: any) {
      if (error?.message?.includes('does not exist') || error?.code === '42000') {
        logger.warn('Stored procedure not found, falling back to aggregateDayInApp');
        return aggregateDayInApp(day);
      }
      throw error;
    }

    const result = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT COUNT(DISTINCT proxy_id) as count FROM proxy_requests_daily_summary WHERE day = ?`,
      dayDate
    );
    const proxyCount = Number(result[0]?.count || 0);
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

  registerCronJob('daily-aggregation', schedule, async () => {
    await aggregateDayInApp();
    const run = lastAggregationRun;
    if (run) {
      const logFn = run.status === 'success' ? logger.info : run.status === 'empty' ? logger.info : logger.error;
      logFn(
        { status: run.status, day: run.day, upserted: run.upserted, durationMs: run.durationMs, reason: run.reason },
        `Daily aggregation job finished: ${run.status}`
      );
    }
  });
}

/**
 * Stops the daily aggregation service.
 */
export function stopDailyAggregationService(): void {
  stopScheduledJob('daily-aggregation');
  isRunning = false;
  logger.info('Daily aggregation service stopped');
}
