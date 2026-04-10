/**
 * Persists snapshots of the Cross-Server Duplicate IP — Per-Phone Detail query
 * (active + all proxy_status scopes). Rows are keyed by captured_at + scope (no separate runs table).
 * Skips writing when the dataset is identical to the last stored snapshot (reduces noise when
 * IP rotation is slower than the snapshot interval).
 */

import { createHash } from 'crypto';
import { logger } from '../lib/logger';
import { prisma } from '../lib/db';
import { hasDatabaseCapacityForBackgroundJobs } from '../lib/db';
import { registerIntervalJob, stopScheduledJob } from './cron.service';

/** Whitelisted Grafana ${proxy_status} values only — never interpolate untrusted input. */
export type ProxyStatusScope = 'active' | 'all';

export interface DuplicateIpSnapshotQueryRow {
  last_ip: string;
  location: string | null;
  all_servers_on_ip: string | null;
  phones_on_same_ip: number | bigint | string;
  sibling_phones: string | null;
  phone_names: string | null;
  device_ids: string | null;
}

let isRunning = false;

/**
 * Builds the panel SQL with a fixed proxy_status scope (safe: only active|all).
 */
export function buildCrossServerDuplicateIpDetailSql(proxyStatusScope: ProxyStatusScope): string {
  if (proxyStatusScope !== 'active' && proxyStatusScope !== 'all') {
    throw new Error('proxyStatusScope must be active or all');
  }
  return `
SELECT
  x.last_ip,
  GROUP_CONCAT(DISTINCT x.location ORDER BY x.location SEPARATOR ' | ') AS location,
  MAX(dup.all_servers_on_ip) AS all_servers_on_ip,
  MAX(dup.phones_on_same_ip) AS phones_on_same_ip,
  MAX(dup.sibling_phones) AS sibling_phones,
  GROUP_CONCAT(x.name ORDER BY x.name SEPARATOR ' | ') AS phone_names,
  GROUP_CONCAT(x.device_id ORDER BY x.name SEPARATOR ' | ') AS device_ids
FROM (
  SELECT
    p.name,
    p.device_id,
    p.last_ip,
    p.proxy_status,
    CONCAT_WS(', ', NULLIF(TRIM(p.city), ''), NULLIF(TRIM(p.state), ''), NULLIF(TRIM(p.country), '')) AS location
  FROM proxies p
  WHERE p.last_ip IS NOT NULL AND p.last_ip != ''
    AND ('${proxyStatusScope}' = 'all' OR p.proxy_status = '${proxyStatusScope}')
) x
JOIN (
  SELECT
    last_ip,
    COUNT(*) AS phones_on_same_ip,
    GROUP_CONCAT(
      DISTINCT CASE WHEN UPPER(TRIM(name)) REGEXP '^S[0-9]{1,3}(P[0-9]+|[[:space:]_-]+P[0-9]+)' THEN REGEXP_SUBSTR(UPPER(TRIM(name)), '^S[0-9]{1,3}') ELSE 'Unknown' END
      ORDER BY CASE WHEN UPPER(TRIM(name)) REGEXP '^S[0-9]{1,3}(P[0-9]+|[[:space:]_-]+P[0-9]+)' THEN CAST(REGEXP_SUBSTR(REGEXP_SUBSTR(UPPER(TRIM(name)), '^S[0-9]{1,3}'), '[0-9]+') AS UNSIGNED) ELSE 999999 END
      SEPARATOR ', '
    ) AS all_servers_on_ip,
    GROUP_CONCAT(name ORDER BY name SEPARATOR ' | ') AS sibling_phones
  FROM proxies
  WHERE last_ip IS NOT NULL AND last_ip != ''
    AND ('${proxyStatusScope}' = 'all' OR proxy_status = '${proxyStatusScope}')
  GROUP BY last_ip
  HAVING COUNT(*) > 1
) dup ON x.last_ip = dup.last_ip
GROUP BY x.last_ip
ORDER BY MAX(dup.phones_on_same_ip) DESC, x.last_ip
`.trim();
}

/**
 * Splits all_servers_on_ip from the query (comma-separated, possibly irregular spaces) into distinct labels.
 */
export function parseServerLabelsFromAllServersOnIp(allServersOnIp: string | null | undefined): string[] {
  if (allServersOnIp == null || allServersOnIp.trim() === '') {
    return [];
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of allServersOnIp.split(',')) {
    const label = part.trim();
    if (label === '' || seen.has(label)) {
      continue;
    }
    seen.add(label);
    out.push(label);
  }
  return out;
}

/**
 * Floors a date to the start of its 5-minute bucket in UTC (idempotent snapshot timestamps).
 */
export function floorToFiveMinuteUtc(d: Date): Date {
  const x = new Date(d.getTime());
  x.setUTCMilliseconds(0);
  const m = x.getUTCMinutes();
  x.setUTCMinutes(m - (m % 5), 0, 0);
  return x;
}

function toInt(n: number | bigint | string): number {
  if (typeof n === 'number') {
    return Math.trunc(n);
  }
  if (typeof n === 'bigint') {
    return Number(n);
  }
  return parseInt(String(n), 10);
}

/**
 * Stable hash of duplicate-IP detail rows so we can skip storing repeated identical snapshots
 * (e.g. when rotation interval is longer than the snapshot tick).
 */
/** Single-row marker when a capture has no duplicate IPs (so empty→empty can be de-duped). */
export const EMPTY_DUPLICATE_SNAPSHOT_LAST_IP = '__snapshot_empty__';

export function fingerprintDuplicateIpDetailRows(rows: DuplicateIpSnapshotQueryRow[]): string {
  const normalized = [...rows]
    .sort((a, b) => a.last_ip.localeCompare(b.last_ip))
    .map((r) =>
      [
        r.last_ip,
        r.location ?? '',
        r.all_servers_on_ip ?? '',
        String(toInt(r.phones_on_same_ip)),
        r.sibling_phones ?? '',
        r.device_ids ?? '',
      ].join('\t')
    )
    .join('\n');
  return createHash('sha256').update(normalized).digest('hex');
}

function fingerprintEmptyDuplicateSnapshot(): string {
  return fingerprintDuplicateIpDetailRows([
    {
      last_ip: EMPTY_DUPLICATE_SNAPSHOT_LAST_IP,
      location: null,
      all_servers_on_ip: null,
      phones_on_same_ip: 0,
      sibling_phones: null,
      phone_names: null,
      device_ids: null,
    },
  ]);
}

function fingerprintFromStoredRows(
  rows: {
    lastIp: string;
    location: string | null;
    allServersOnIp: string | null;
    phonesOnSameIp: number;
    siblingPhones: string | null;
    deviceIds: string | null;
  }[]
): string {
  const asQuery: DuplicateIpSnapshotQueryRow[] = rows.map((r) => ({
    last_ip: r.lastIp,
    location: r.location,
    all_servers_on_ip: r.allServersOnIp,
    phones_on_same_ip: r.phonesOnSameIp,
    sibling_phones: r.siblingPhones,
    phone_names: null,
    device_ids: r.deviceIds,
  }));
  return fingerprintDuplicateIpDetailRows(asQuery);
}

function shouldSkipUnchangedSnapshots(): boolean {
  return process.env.DUPLICATE_IP_SNAPSHOT_SKIP_UNCHANGED !== 'false';
}

/**
 * Runs one snapshot for a single scope: insert rows + normalized server rows (no separate run row).
 */
export async function runDuplicateIpSnapshotForScope(
  capturedAt: Date,
  proxyStatusScope: ProxyStatusScope
): Promise<{ rowCount: number; skipped: boolean; skipReason?: 'bucket_exists' | 'unchanged' }> {
  const existingInBucket = await prisma.duplicateIpSnapshotRow.count({
    where: { capturedAt, proxyStatusScope },
  });
  if (existingInBucket > 0) {
    logger.info(
      { capturedAt, proxyStatusScope },
      'Duplicate IP snapshot bucket already stored, skipping'
    );
    return { rowCount: existingInBucket, skipped: true, skipReason: 'bucket_exists' };
  }

  const sql = buildCrossServerDuplicateIpDetailSql(proxyStatusScope);
  const rawRows = await prisma.$queryRawUnsafe<DuplicateIpSnapshotQueryRow[]>(sql);
  const fpCurrent =
    rawRows.length === 0 ? fingerprintEmptyDuplicateSnapshot() : fingerprintDuplicateIpDetailRows(rawRows);

  if (shouldSkipUnchangedSnapshots()) {
    const lastAt = await prisma.duplicateIpSnapshotRow.findFirst({
      where: { proxyStatusScope },
      orderBy: { capturedAt: 'desc' },
      select: { capturedAt: true },
    });
    if (lastAt) {
      const prevRows = await prisma.duplicateIpSnapshotRow.findMany({
        where: {
          proxyStatusScope,
          capturedAt: lastAt.capturedAt,
        },
        select: {
          lastIp: true,
          location: true,
          allServersOnIp: true,
          phonesOnSameIp: true,
          siblingPhones: true,
          deviceIds: true,
        },
      });
      if (prevRows.length > 0 && fingerprintFromStoredRows(prevRows) === fpCurrent) {
        logger.info(
          { capturedAt, proxyStatusScope, rowCount: rawRows.length },
          'Duplicate IP snapshot unchanged vs previous capture, skipping insert'
        );
        return { rowCount: rawRows.length, skipped: true, skipReason: 'unchanged' };
      }
    }
  }

  if (rawRows.length === 0) {
    await prisma.duplicateIpSnapshotRow.create({
      data: {
        capturedAt,
        proxyStatusScope,
        lastIp: EMPTY_DUPLICATE_SNAPSHOT_LAST_IP,
        location: null,
        allServersOnIp: null,
        phonesOnSameIp: 0,
        siblingPhones: null,
        deviceIds: null,
      },
    });
    return { rowCount: 0, skipped: false };
  }

  await prisma.duplicateIpSnapshotRow.createMany({
    data: rawRows.map((r) => ({
      capturedAt,
      proxyStatusScope,
      lastIp: r.last_ip,
      location: r.location,
      allServersOnIp: r.all_servers_on_ip,
      phonesOnSameIp: toInt(r.phones_on_same_ip),
      siblingPhones: r.sibling_phones,
      deviceIds: r.device_ids,
    })),
  });

  const serverRows: { capturedAt: Date; proxyStatusScope: string; lastIp: string; serverLabel: string }[] =
    [];
  for (const r of rawRows) {
    for (const serverLabel of parseServerLabelsFromAllServersOnIp(r.all_servers_on_ip)) {
      serverRows.push({ capturedAt, proxyStatusScope, lastIp: r.last_ip, serverLabel });
    }
  }
  if (serverRows.length > 0) {
    const batchSize = 2000;
    for (let i = 0; i < serverRows.length; i += batchSize) {
      const batch = serverRows.slice(i, i + batchSize);
      await prisma.duplicateIpSnapshotServer.createMany({ data: batch });
    }
  }

  return { rowCount: rawRows.length, skipped: false };
}

/**
 * Captures both active and all scopes at the same 5-minute bucket, then optionally prunes old rows.
 */
export async function runDuplicateIpSnapshots(options?: {
  capturedAt?: Date;
  runRetentionPrune?: boolean;
  retentionDays?: number;
}): Promise<void> {
  const hasCapacity = await hasDatabaseCapacityForBackgroundJobs();
  if (!hasCapacity) {
    logger.warn('Skipping duplicate IP snapshot tick due to database pool pressure');
    return;
  }

  const capturedAt = options?.capturedAt ?? floorToFiveMinuteUtc(new Date());
  const scopes: ProxyStatusScope[] = ['active', 'all'];

  for (const proxyStatusScope of scopes) {
    try {
      const { rowCount, skipped, skipReason } = await runDuplicateIpSnapshotForScope(capturedAt, proxyStatusScope);
      logger.info(
        { capturedAt, proxyStatusScope, rowCount, skipped, skipReason },
        'Duplicate IP snapshot completed'
      );
    } catch (e) {
      logger.error(
        { err: e instanceof Error ? e.message : e, stack: e instanceof Error ? e.stack : undefined, capturedAt, proxyStatusScope },
        'Duplicate IP snapshot failed for scope'
      );
    }
  }

  if (options?.runRetentionPrune !== false) {
    try {
      const days = options?.retentionDays ?? parseInt(process.env.DUPLICATE_IP_SNAPSHOT_RETENTION_DAYS || '90', 10);
      const deleted = await pruneDuplicateIpSnapshotsOlderThanDays(days);
      if (deleted > 0) {
        logger.info({ deleted, retentionDays: days }, 'Duplicate IP snapshot retention prune completed');
      }
    } catch (e) {
      logger.error(
        { err: e instanceof Error ? e.message : e },
        'Duplicate IP snapshot retention prune failed'
      );
    }
  }
}

/**
 * Deletes snapshot rows older than the cutoff (servers first).
 */
export async function pruneDuplicateIpSnapshotsOlderThanDays(retentionDays: number): Promise<number> {
  if (retentionDays < 1) {
    return 0;
  }
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  const s = await prisma.duplicateIpSnapshotServer.deleteMany({
    where: { capturedAt: { lt: cutoff } },
  });
  const r = await prisma.duplicateIpSnapshotRow.deleteMany({
    where: { capturedAt: { lt: cutoff } },
  });
  return s.count + r.count;
}

/**
 * Starts periodic snapshots and retention (retention runs daily on a separate timer).
 */
export function startDuplicateIpSnapshotService(intervalMs: number, retentionDays: number): void {
  if (isRunning) {
    return;
  }
  isRunning = true;

  const tick = (): void => {
    void runDuplicateIpSnapshots({ retentionDays, runRetentionPrune: false }).catch((e) => {
      logger.error(
        { err: e instanceof Error ? e.message : e, stack: e instanceof Error ? e.stack : undefined },
        'Duplicate IP snapshot tick failed'
      );
    });
  };

  registerIntervalJob('duplicate-ip-snapshot-tick', intervalMs, tick, { runImmediately: true });

  const dayMs = 24 * 60 * 60 * 1000;
  registerIntervalJob('duplicate-ip-snapshot-retention', dayMs, async () => {
    const deleted = await pruneDuplicateIpSnapshotsOlderThanDays(retentionDays);
    if (deleted > 0) {
      logger.info({ deleted, retentionDays }, 'Duplicate IP snapshot daily retention prune');
    }
  });

  logger.info({ intervalMs, retentionDays }, 'Duplicate IP snapshot service started');
}

/**
 * Stops periodic snapshots and retention timers.
 */
export function stopDuplicateIpSnapshotService(): void {
  stopScheduledJob('duplicate-ip-snapshot-tick');
  stopScheduledJob('duplicate-ip-snapshot-retention');
  isRunning = false;
  logger.info('Duplicate IP snapshot service stopped');
}
