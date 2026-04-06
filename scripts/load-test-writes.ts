/**
 * Load Test: Simulate sustained write load while aggregation runs
 *
 * Simulates the write worker path (proxy_requests inserts) at a configurable
 * rate while optionally triggering aggregation concurrently, then reports
 * latency, throughput, error rate, and connection pool pressure.
 *
 * Usage:
 *   npx ts-node scripts/load-test-writes.ts [options]
 *
 * Options:
 *   --proxies=N          Number of proxy IDs to spread writes across (default: 20)
 *   --rate=N             Target inserts per second (default: 33)
 *   --duration=N         Test duration in seconds (default: 120)
 *   --batch=N            Rows per createMany call (default: 50)
 *   --concurrency=N      Parallel write workers (default: 5)
 *   --with-aggregation   Trigger aggregateDayInApp() halfway through the test
 *   --day=YYYY-MM-DD     Day to aggregate (default: yesterday)
 */

import 'dotenv/config';
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
function arg(name: string, fallback: string): string {
  const prefix = `--${name}=`;
  const found = process.argv.find((a) => a.startsWith(prefix));
  if (found) return found.slice(prefix.length);
  const idx = process.argv.indexOf(`--${name}`);
  if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1];
  return fallback;
}

const PROXY_COUNT       = parseInt(arg('proxies', '20'), 10);
const TARGET_RPS        = parseInt(arg('rate', '33'), 10);
const DURATION_S        = parseInt(arg('duration', '120'), 10);
const BATCH_SIZE        = parseInt(arg('batch', '50'), 10);
const CONCURRENCY       = parseInt(arg('concurrency', '5'), 10);
const WITH_AGGREGATION  = process.argv.includes('--with-aggregation');
const AGG_DAY           = arg('day', '');

// ---------------------------------------------------------------------------
// DB clients — mirror prod pool sizes
// ---------------------------------------------------------------------------
function makeClient(limit: number): PrismaClient {
  const url = new URL(process.env.DATABASE_URL!);
  url.searchParams.set('connection_limit', String(limit));
  url.searchParams.set('pool_timeout', '30');
  return new PrismaClient({ datasources: { db: { url: url.toString() } } });
}

const writeDb      = makeClient(20);
const backgroundDb = makeClient(8);

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------
interface Stats {
  inserted:    number;
  errors:      number;
  latencies:   number[];   // ms per batch
  startedAt:   number;
}

const stats: Stats = { inserted: 0, errors: 0, latencies: [], startedAt: Date.now() };

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
}

function printStats(label: string): void {
  const elapsed   = (Date.now() - stats.startedAt) / 1000;
  const rps       = stats.inserted / elapsed;
  const sorted    = [...stats.latencies].sort((a, b) => a - b);
  const p50       = percentile(sorted, 50);
  const p95       = percentile(sorted, 95);
  const p99       = percentile(sorted, 99);

  console.log(`\n── ${label} ──────────────────────────────`);
  console.log(`  elapsed   : ${elapsed.toFixed(1)}s`);
  console.log(`  inserted  : ${stats.inserted.toLocaleString()} rows`);
  console.log(`  errors    : ${stats.errors}`);
  console.log(`  actual RPS: ${rps.toFixed(1)}`);
  console.log(`  batch p50 : ${p50}ms`);
  console.log(`  batch p95 : ${p95}ms`);
  console.log(`  batch p99 : ${p99}ms`);
  console.log(`  max batch : ${sorted[sorted.length - 1] ?? 0}ms`);
}

// ---------------------------------------------------------------------------
// Fake proxy IDs (use real ones from DB if available)
// ---------------------------------------------------------------------------
async function resolveProxyIds(): Promise<string[]> {
  const rows = await writeDb.$queryRawUnsafe<Array<{ device_id: string }>>(
    `SELECT device_id FROM proxies ORDER BY RAND() LIMIT ?`,
    PROXY_COUNT
  );

  if (rows.length > 0) {
    console.log(`Using ${rows.length} real proxy IDs from DB`);
    return rows.map((r) => r.device_id);
  }

  // Fallback: synthetic IDs (inserts will skip FK check since we dropped the FK)
  console.log(`No proxies found in DB — using ${PROXY_COUNT} synthetic IDs`);
  return Array.from({ length: PROXY_COUNT }, (_, i) => `load-test-proxy-${i + 1}`);
}

// ---------------------------------------------------------------------------
// Single batch insert
// ---------------------------------------------------------------------------
const STATUSES   = ['SUCCESS', 'SUCCESS', 'SUCCESS', 'TIMEOUT', 'CONNECTION_ERROR'];
const TARGET_URL = 'https://load-test.internal/check';

function makeRow(proxyId: string) {
  const status   = STATUSES[Math.floor(Math.random() * STATUSES.length)];
  const success  = status === 'SUCCESS';
  return {
    id:                randomUUID(),
    proxyId,
    timestamp:         new Date(),
    targetUrl:         TARGET_URL,
    status,
    responseTimeMs:    success ? Math.floor(200 + Math.random() * 800) : null,
    outboundIp:        success ? `10.${Math.floor(Math.random()*255)}.${Math.floor(Math.random()*255)}.1` : null,
    expectedIp:        null,
    ipChanged:         false,
    errorType:         success ? null : status,
    errorMessage:      success ? null : `Simulated ${status}`,
    source:            'load_test',
    downloadSpeedMbps: success ? Math.random() * 50 : null,
    uploadSpeedMbps:   success ? Math.random() * 20 : null,
  };
}

async function insertBatch(proxyIds: string[], batchSize: number): Promise<void> {
  const rows = Array.from({ length: batchSize }, () =>
    makeRow(proxyIds[Math.floor(Math.random() * proxyIds.length)])
  );

  const t0 = Date.now();
  try {
    const result = await writeDb.proxyRequest.createMany({
      data:           rows as any,
      skipDuplicates: true,
    });
    const ms = Date.now() - t0;
    stats.inserted  += result.count;
    stats.latencies.push(ms);
  } catch (err: any) {
    stats.errors++;
    console.error(`  [ERROR] batch insert failed: ${err?.message?.slice(0, 120)}`);
  }
}

// ---------------------------------------------------------------------------
// Worker: fires batches to hit target RPS
// ---------------------------------------------------------------------------
async function runWorker(proxyIds: string[], durationMs: number, rpsPerWorker: number): Promise<void> {
  const intervalMs = (BATCH_SIZE / rpsPerWorker) * 1000;
  const deadline   = Date.now() + durationMs;

  while (Date.now() < deadline) {
    const t0 = Date.now();
    await insertBatch(proxyIds, BATCH_SIZE);
    const elapsed = Date.now() - t0;
    const wait    = Math.max(0, intervalMs - elapsed);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
}

// ---------------------------------------------------------------------------
// Aggregation trigger
// ---------------------------------------------------------------------------
async function triggerAggregation(): Promise<void> {
  const { aggregateDayInApp } = await import('../src/services/daily-aggregation');

  const day = AGG_DAY
    ? new Date(AGG_DAY)
    : new Date(Date.now() - 24 * 60 * 60 * 1000);

  console.log(`\n  ▶ Triggering aggregateDayInApp(${day.toISOString().split('T')[0]}) on backgroundDb`);
  const t0  = Date.now();
  const n   = await aggregateDayInApp(day);
  const sec = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`  ✓ Aggregation done: ${n} proxies in ${sec}s`);
}

// ---------------------------------------------------------------------------
// Progress printer
// ---------------------------------------------------------------------------
function startProgressPrinter(intervalS = 10): NodeJS.Timeout {
  return setInterval(() => printStats('progress'), intervalS * 1000);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║          proxy_requests Write Load Test              ║');
  console.log('╚══════════════════════════════════════════════════════╝');
  console.log(`  proxies     : ${PROXY_COUNT}`);
  console.log(`  target RPS  : ${TARGET_RPS}`);
  console.log(`  duration    : ${DURATION_S}s`);
  console.log(`  batch size  : ${BATCH_SIZE}`);
  console.log(`  concurrency : ${CONCURRENCY}`);
  console.log(`  aggregation : ${WITH_AGGREGATION ? 'YES (at 50% mark)' : 'NO'}`);
  console.log('');

  const proxyIds    = await resolveProxyIds();
  const durationMs  = DURATION_S * 1000;
  const rpsPerWorker = TARGET_RPS / CONCURRENCY;

  stats.startedAt = Date.now();
  const printer   = startProgressPrinter(15);

  // Launch write workers
  const workers = Array.from({ length: CONCURRENCY }, () =>
    runWorker(proxyIds, durationMs, rpsPerWorker)
  );

  // Optionally trigger aggregation halfway through
  if (WITH_AGGREGATION) {
    setTimeout(() => {
      void triggerAggregation();
    }, durationMs / 2);
  }

  await Promise.all(workers);
  clearInterval(printer);

  // Final report
  printStats('FINAL RESULTS');

  // Cleanup load test rows so they don't pollute real data
  console.log('\n  Cleaning up load_test rows...');
  await writeDb.$executeRawUnsafe(
    `DELETE FROM proxy_requests WHERE source = 'load_test'`
  );
  console.log('  Done.');

  await writeDb.$disconnect();
  await backgroundDb.$disconnect();
}

main().catch((err) => {
  console.error('Load test failed:', err);
  process.exit(1);
});
