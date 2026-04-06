/**
 * Standalone Aggregation Runner
 *
 * Calls the exact same aggregateDayInApp() used by the cron scheduler,
 * so this script tests the real production code path.
 *
 * Usage:
 *   npx ts-node scripts/run-aggregation.ts                  # yesterday
 *   npx ts-node scripts/run-aggregation.ts --day=2026-04-05 # specific day
 *   npx ts-node scripts/run-aggregation.ts --days=7         # last 7 days
 *   npx ts-node scripts/run-aggregation.ts --day=2026-04-01 --to=2026-04-05  # date range
 */

import 'dotenv/config';
import { aggregateDayInApp } from '../src/services/daily-aggregation';
import { backgroundDb as db } from '../src/lib/db';

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
function arg(name: string, fallback = ''): string {
  const prefix = `--${name}=`;
  const found = process.argv.find((a) => a.startsWith(prefix));
  if (found) return found.slice(prefix.length);
  const idx = process.argv.indexOf(`--${name}`);
  if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1];
  return fallback;
}

const DAY_ARG  = arg('day');
const TO_ARG   = arg('to');
const DAYS_ARG = arg('days');

// ---------------------------------------------------------------------------
// Build list of days to process
// ---------------------------------------------------------------------------
function buildDayList(): Date[] {
  if (DAYS_ARG) {
    const n = parseInt(DAYS_ARG, 10);
    if (isNaN(n) || n < 1) { console.error(`Invalid --days: ${DAYS_ARG}`); process.exit(1); }
    const now = new Date();
    return Array.from({ length: n }, (_, i) => {
      const d = new Date(now.getTime() - (i + 1) * 24 * 60 * 60 * 1000);
      d.setUTCHours(0, 0, 0, 0);
      return d;
    }).reverse();
  }

  if (DAY_ARG && TO_ARG) {
    const start = new Date(`${DAY_ARG}T00:00:00Z`);
    const end   = new Date(`${TO_ARG}T00:00:00Z`);
    if (isNaN(start.getTime()) || isNaN(end.getTime()) || end < start) {
      console.error('Invalid --day / --to range'); process.exit(1);
    }
    const list: Date[] = [];
    for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
      list.push(new Date(d));
    }
    return list;
  }

  if (DAY_ARG) {
    const d = new Date(`${DAY_ARG}T00:00:00Z`);
    if (isNaN(d.getTime())) { console.error(`Invalid --day: ${DAY_ARG}`); process.exit(1); }
    return [d];
  }

  // Default: yesterday
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
  yesterday.setUTCHours(0, 0, 0, 0);
  return [yesterday];
}

// ---------------------------------------------------------------------------
// Print summary row from proxy_requests_daily_summary after aggregation
// ---------------------------------------------------------------------------
function fmt(n: number | null | undefined): string {
  return n == null ? 'null' : Number(n).toFixed(1);
}

async function printDaySummary(dayLabel: string): Promise<void> {
  const rows = await db.$queryRawUnsafe<Array<{
    proxies:          bigint;
    total_requests:   bigint;
    avg_success_rate: number;
    avg_p50:          number | null;
    avg_p95:          number | null;
  }>>(
    `SELECT
       COUNT(*)                  AS proxies,
       SUM(total_requests)       AS total_requests,
       AVG(success_rate_pct)     AS avg_success_rate,
       AVG(p50_response_time_ms) AS avg_p50,
       AVG(p95_response_time_ms) AS avg_p95
     FROM proxy_requests_daily_summary
     WHERE day = ?`,
    dayLabel
  );

  const r = rows[0];
  if (!r) { console.log(`  [${dayLabel}] no rows in summary table`); return; }
  console.log(
    `  [${dayLabel}] summary → proxies: ${r.proxies}, ` +
    `requests: ${r.total_requests}, ` +
    `success: ${fmt(r.avg_success_rate)}%, ` +
    `p50: ${fmt(r.avg_p50)}ms, p95: ${fmt(r.avg_p95)}ms`
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║          proxy_requests_daily_summary Runner         ║');
  console.log('║          (uses production aggregateDayInApp)         ║');
  console.log('╚══════════════════════════════════════════════════════╝');

  const days = buildDayList();
  console.log(`  days to process : ${days.map((d) => d.toISOString().split('T')[0]).join(', ')}\n`);

  let totalUpserted = 0;
  const globalT0    = Date.now();

  for (const day of days) {
    const dayLabel = day.toISOString().split('T')[0];
    const t0       = Date.now();

    console.log(`  [${dayLabel}] starting...`);
    const upserted = await aggregateDayInApp(day);
    const sec      = ((Date.now() - t0) / 1000).toFixed(1);

    console.log(`  [${dayLabel}] done — ${upserted} proxies upserted in ${sec}s`);
    await printDaySummary(dayLabel);

    totalUpserted += upserted;

    if (days.indexOf(day) < days.length - 1) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  const totalSec = ((Date.now() - globalT0) / 1000).toFixed(1);
  console.log(`\n── DONE ───────────────────────────────────────────────`);
  console.log(`  total proxies upserted : ${totalUpserted}`);
  console.log(`  total time             : ${totalSec}s`);

  await db.$disconnect();
}

main().catch((err) => {
  console.error('Aggregation script failed:', err);
  process.exit(1);
});
