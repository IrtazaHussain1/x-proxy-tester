/**
 * Backfill runner for ip_rotation_6h_summary.
 *
 * Calls aggregateBucketRange() — the same function the scheduled service uses —
 * so this script exercises the real production code path.
 *
 * Usage:
 *   npm run backfill:rotation:dev                                          # yesterday (4 buckets)
 *   npm run backfill:rotation:dev -- --day=2026-06-01                     # single day
 *   npm run backfill:rotation:dev -- --from=2026-06-01 --to=2026-06-07   # date range
 */

import 'dotenv/config';
import { aggregateBucketRange } from '../src/services/ip-rotation-aggregation';
import { backgroundDb } from '../src/lib/db';

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

function arg(name: string, fallback = ''): string {
  const prefix = `--${name}=`;
  const found = process.argv.find((a) => a.startsWith(prefix));
  if (found) return found.slice(prefix.length);
  const idx = process.argv.indexOf(`--${name}`);
  if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1]!;
  return fallback;
}

const DAY_ARG  = arg('day');
const FROM_ARG = arg('from');
const TO_ARG   = arg('to');

function buildRange(): { startDate: Date; endDate: Date } {
  if (FROM_ARG && TO_ARG) {
    const startDate = new Date(`${FROM_ARG}T00:00:00Z`);
    const endDate   = new Date(`${TO_ARG}T23:59:59Z`);
    if (isNaN(startDate.getTime()) || isNaN(endDate.getTime()) || endDate < startDate) {
      console.error('Invalid --from / --to range');
      process.exit(1);
    }
    return { startDate, endDate };
  }

  if (DAY_ARG) {
    const startDate = new Date(`${DAY_ARG}T00:00:00Z`);
    if (isNaN(startDate.getTime())) {
      console.error(`Invalid --day: ${DAY_ARG}`);
      process.exit(1);
    }
    const endDate = new Date(`${DAY_ARG}T23:59:59Z`);
    return { startDate, endDate };
  }

  // Default: yesterday
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
  yesterday.setUTCHours(0, 0, 0, 0);
  const endDate = new Date(yesterday.getTime() + 24 * 60 * 60 * 1000 - 1);
  return { startDate: yesterday, endDate };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { startDate, endDate } = buildRange();
  const from = startDate.toISOString().split('T')[0]!;
  const to   = endDate.toISOString().split('T')[0]!;

  console.log(`ip-rotation-aggregation backfill: ${from} → ${to}`);

  try {
    const total = await aggregateBucketRange(startDate, endDate);
    console.log(`Backfill complete: ${total} rows upserted across ${from} → ${to}`);
  } finally {
    await backgroundDb.$disconnect();
  }
}

main().catch((err) => {
  console.error('Backfill script failed:', err);
  process.exit(1);
});
