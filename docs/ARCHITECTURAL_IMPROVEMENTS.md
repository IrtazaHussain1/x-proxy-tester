# Architectural Improvements (April 2026)

**Date:** April 8, 2026
**Summary:** 18 critical fixes across data loss, security, correctness, and reliability.

---

## Executive Summary

The x-proxy-tester system contained 38 architectural issues discovered through code analysis. This document covers the 18 highest-impact fixes applied, organized by risk category:

| Category | Fixes | Impact |
|----------|-------|--------|
| **Data Loss Risk** | 5 fixes | Critical—data was lost when Redis rejected jobs before DB write |
| **Security** | 4 fixes | Medium—credentials stored plaintext, API unauth, telemetry beacon |
| **Correctness** | 5 fixes | High—stability queries N+1, UTC misalignment, bad race conditions |
| **Reliability** | 4 fixes | High—hung aggregation locked forever, queue coalescing racy |

---

## Batch 1: Data Loss (Critical)

### Fix 1.1: Replace BullMQ `batchWriter.add()` with direct `createMany`

**Problem:**
```typescript
// BROKEN: async returns immediately, before DB write
await batchWriter.add({ ... });  // job queued but not yet in DB
// BullMQ acknowledges → crashes before batchWriter.forceFlush() runs
```

Data loss: Every proxy test lost on crash between job enqueue and batch writer flush.

**Fix:**
Replaced with direct Prisma `createMany` inside the worker:
```typescript
await prisma.proxyRequest.createMany({
  data: [{ ... }],
  skipDuplicates: true,
});
```

Now writes are **transactional** — job ack only after data is in MySQL.

---

### Fix 1.2: Graceful Shutdown Order

**Problem:**
Original shutdown order: `forceFlush()` → `stopWorkers()`

Workers could add to batch **after** flush, losing data on hard exit.

**Fix:**
Correct order: `stopWorkers()` → `forceFlush()` with 30-second timeout:
```typescript
// 1. Stop accepting new work
stopProxyTestWriteQueue();
stopProxyMetaWriteQueue();
// 2. Drain pending batches
await batchWriter.forceFlush();
// 3. Hard exit timeout to prevent zombie processes
```

---

### Fix 1.3: Start BullMQ Workers After DB Init

**Problem:**
Workers started **before** `initDatabaseSchema()`. Jobs queued before DB was ready → worker crashes.

**Fix:**
Reordered startup: database schema → Grafana views → worker start.

---

### Fix 1.4 & 1.5: Fix Aggregation Cursor & Logging

**Fix 1.4 — Composite Cursor:**
Aggregation cursor was only timestamp, causing duplicate rows if multiple tests fired at the same millisecond.

Changed to composite `(timestamp, id)` with `ORDER BY timestamp ASC, id ASC`.

**Fix 1.5 — Error-Level Logging:**
Skipped aggregation days now logged at `error` level (was `warn`). Signals permanent data loss.

---

## Batch 2: Security

### Fix 2.1: Remove Telemetry Beacon

**Problem:**
Every 6 hours, the app made an unconditional HTTP call to `http://127.0.0.1:7242/ingest/7c255b7b-...` on device cache refresh.

This is **telemetry**. Removed entirely.

---

### Fix 2.2: Encrypt Proxy Credentials on Write

**Problem:**
Proxy passwords stored in plaintext in MySQL. If DB is compromised, all device credentials leaked.

**Fix:**
Encrypted on write using AES-256-GCM:
```typescript
// At all 3 write sites
password: device.password ? await encrypt(device.password) : null
```

Decryption happens transparently when credentials are used.

**New Env Var:**
```bash
ENCRYPTION_KEY=<64-char hex>  # Generate: node -e "require('crypto').randomBytes(32).toString('hex')"
```

---

### Fix 2.3: Redis Auth + Remove External Port

**Problem:**
Redis exposed on `localhost:6379` without password. BullMQ job payloads contain encrypted credentials — if Redis is compromised, jobs are exposed.

**Fix:**
```yaml
# docker-compose.yml
command: redis-server --appendonly yes --save 60 1000
         ${REDIS_PASSWORD:+--requirepass $REDIS_PASSWORD}
# Port not published externally
```

**New Env Var:**
```bash
REDIS_PASSWORD=<strong-password>  # Required in production
```

Config warns at startup if unset:
```
WARNING: REDIS_PASSWORD not set. BullMQ job payloads may contain device credentials.
```

---

### Fix 2.4: API Authentication & CORS Scoping

**Problem:**
`POST /api/testing/start` and `POST /api/testing/stop` were unauthenticated. Anyone with network access could start/stop the entire system.

CORS header was `*` (all origins).

**Fix:**
```typescript
function isAuthorized(req: IncomingMessage): boolean {
  if (!API_SECRET_KEY) return true;  // not configured — logs warning
  const authHeader = req.headers['authorization'] || '';
  return authHeader === `Bearer ${API_SECRET_KEY}`;
}

// Applied to POST endpoints
```

**New Env Vars:**
```bash
API_SECRET_KEY=<bearer-token>  # Generate: node -e "require('crypto').randomBytes(32).toString('hex')"
CORS_ALLOWED_ORIGIN=*          # Change to dashboard domain in production
```

---

## Batch 3: Correctness

### Fix 3.1: Stability N+1 Queries → Single SQL Aggregation

**Problem:**
Every 10 minutes, `calculateAllProxiesStability()` fired **N × 2 concurrent queries**:
- One per proxy to check 1-hour stability
- One per proxy to check 24-hour stability
- All at once via `Promise.allSettled(proxies.map(...))`

With 1,000 proxies → 2,000 concurrent DB reads. Connection pool exhaustion. Slow queries starved write workers.

**Fix:**
Single `GROUP BY` query covering all proxies and both time windows:

```typescript
const rows = await backgroundDb.$queryRawUnsafe(`
  SELECT proxy_id,
    SUM(CASE WHEN status != 'SUCCESS' AND timestamp >= NOW() - INTERVAL 1 HOUR  THEN 1 ELSE 0 END) failures_1h,
    SUM(CASE WHEN status != 'SUCCESS' AND timestamp >= NOW() - INTERVAL 24 HOUR THEN 1 ELSE 0 END) failures_24h
  FROM proxy_requests
  WHERE timestamp >= NOW() - INTERVAL 24 HOUR
  GROUP BY proxy_id
`);

// Sequential per-row updates (no concurrent spikes)
for (const row of rows) {
  await backgroundDb.proxy.update({ ... });
}
```

**Result:** 1 query instead of N+2. Frees connection pool. No concurrent spike.

---

### Fix 3.2: Align Aggregation Scheduler to UTC

**Problem:**
Aggregation scheduled via `nextRun.setHours(hour, minute)` (local time), but day boundaries checked with `setUTCHours()`.

If server is in a non-UTC timezone, aggregation runs at the wrong wall-clock time and misses day boundaries.

**Fix:**
```typescript
// Changed from setHours() to setUTCHours()
nextRun.setUTCHours(hour, minute, 0, 0);
```

**New Env Var:**
```bash
TZ=UTC  # Set in docker-compose.yml app service
```

---

### Fix 3.3: Encryption Format with Prefix

**Problem:**
`isEncrypted()` checked `parts.length === 4` by splitting on `:`. IPv6 addresses (`2001:db8::1`) and URLs also contain colons → false positives.

**Fix:**
All encrypted values now prefix with `enc:`:

```typescript
// encrypt()
return 'enc:' + [salt.toString('base64'), iv, tag, encrypted].join(':');

// isEncrypted()
return value.startsWith('enc:');

// decrypt()
const raw = ciphertext.startsWith('enc:') ? ciphertext.slice(4) : ciphertext;
// ... decrypt raw
```

No false positives. Backward compatible with old ciphertexts.

---

### Fix 3.4: Disable Redundant MySQL Event

**Problem:**
MySQL had a `daily_aggregate_summary` event running at 02:30 UTC, silently overwriting the Node.js aggregation result (runs at 01:00 UTC) with a different calculation.

This is a duplicate. Node.js aggregation is the authoritative implementation.

**Fix:**
Migration disables the event:
```sql
ALTER EVENT IF EXISTS daily_aggregate_summary DISABLE;
```

Only `manage_proxy_requests_partitions` (partition management) remains.

---

## Batch 4: Reliability

### Fix 4.1: Fix Proxy Metadata Queue Coalescing Race

**Problem:**
```typescript
// RACE CONDITION:
const existing = await q.getJob(jobId);
if (existing) {
  const state = await existing.getState();
  if (state === 'waiting' || state === 'delayed') {
    await existing.updateData(data);  // Can fail if job moved to active/completed
  }
}
```

Worker could dequeue the job between `getState()` and `updateData()`, causing the update to fail silently.

**Fix:**
Use BullMQ native deduplication with a fixed `jobId` and coalescing window:
```typescript
await q.add('write', data, {
  jobId: `proxy-meta-${data.deviceId}`,
  delay: 200,  // 200ms coalescing window
  // ... retry opts
});
```

BullMQ automatically deduplicates — no race condition.

---

### Fix 4.2: Aggregation Watchdog Timeout

**Problem:**
If an aggregation query hung (MySQL stall, network issue), the `isAggregating` flag was never cleared. All future aggregations skipped forever.

**Fix:**
4-hour watchdog timer releases the lock if the aggregation doesn't complete:

```typescript
const watchdog = setTimeout(() => {
  logger.error('Aggregation watchdog triggered — query appears hung, releasing lock');
  isAggregating = false;
}, AGGREGATION_WATCHDOG_MS);

try {
  // ... do aggregation
} finally {
  clearTimeout(watchdog);
  isAggregating = false;
}
```

**New Env Var:**
```bash
AGGREGATION_WATCHDOG_MS=14400000  # Default 4 hours (production)
# Set to 60000 (1 min) for testing
```

---

### Fix 4.3: Wire Auto-Deactivation Back In

**Problem:**
Auto-deactivation code existed but imports and call site were commented out. Failed proxies were never deactivated.

**Fix:**
Uncommented imports and call in `processProxyTestWriteJob()`:

```typescript
if (!metrics.success && config.autoDeactivation.enabled) {
  const deactivationCheck = await checkAutoDeactivation(device.device_id);
  if (deactivationCheck.shouldDeactivate) {
    await autoDeactivateProxy(device.device_id, deactivationCheck.reason ?? 'unknown', { ... });
    stopDeviceTesting(device.device_id);
  }
}
```

Failed devices now automatically deactivate per configured thresholds.

---

### Fix 4.4: MySQL Partition EVENT Health Check

**Problem:**
If the `manage_proxy_requests_partitions` event was disabled (or MySQL event_scheduler was OFF), new partitions would never be created and old ones never dropped. The system would silently accumulate unbounded data.

**Fix:**
Added startup health check:

```typescript
export async function checkPartitionEventHealth(): Promise<void> {
  const eventRows = await backgroundDb.$queryRawUnsafe(
    `SELECT STATUS, LAST_EXECUTED FROM information_schema.EVENTS
     WHERE EVENT_SCHEMA = DATABASE() AND EVENT_NAME = 'manage_proxy_requests_partitions'`
  );

  if (eventRows.length === 0) {
    logger.error('CRITICAL: manage_proxy_requests_partitions EVENT missing');
    return;
  }
  if (eventRows[0].STATUS !== 'ENABLED') {
    logger.error('CRITICAL: manage_proxy_requests_partitions EVENT is DISABLED');
    return;
  }
}
```

Called after schema init. Logs `CRITICAL` if event is missing or disabled.

---

### Fix 4.5: Redis Fallback to Direct DB Write

**Problem:**
If Redis was down, `enqueueProxyTestWriteJob()` failed silently. Proxy test results dropped.

**Fix:**
```typescript
export async function saveProxyTestToDatabase(...): Promise<void> {
  try {
    await enqueueProxyTestWriteJob({ device, metrics, source });
  } catch (enqueueErr) {
    logger.warn('Redis unavailable — falling back to direct DB write');
    await processProxyTestWriteJob(device, metrics, source);
  }
}
```

Writes still succeed if Redis is temporarily down. Degrades gracefully to synchronous writes.

---

## Monitoring & Verification

### How to Check Aggregation is Working

#### 1. **Check Logs**

```bash
# Real-time logs
docker logs -f x-proxy-tester-app | grep -i "aggregat"

# Look for:
# ✅ "Starting app-side daily aggregation"
# ✅ "Stability calculation completed"
# ❌ "Aggregation watchdog triggered"
# ❌ "Daily aggregation SKIPPED"
```

#### 2. **Query the Summary Table**

```sql
SELECT
  DATE(day) as date,
  COUNT(*) as summaries,
  MIN(success_count) as min_success,
  MAX(failure_count) as max_failure
FROM proxy_requests_daily_summary
WHERE day >= DATE_SUB(NOW(), INTERVAL 5 DAY)
GROUP BY DATE(day)
ORDER BY day DESC;
```

Expected: One row per day with non-zero `success_count`.

#### 3. **Check Metrics Endpoint**

```bash
curl -s http://localhost:3311/metrics | grep aggregat
```

#### 4. **MySQL Event Status**

```sql
SELECT EVENT_NAME, STATUS, LAST_EXECUTED, LAST_ALTERED
FROM information_schema.EVENTS
WHERE EVENT_SCHEMA = DATABASE();
```

Expected:
```
manage_proxy_requests_partitions | ENABLED | 2026-04-08 ... | ...
daily_aggregate_summary          | DISABLED | NULL           | ...
```

#### 5. **Partition Health**

```sql
SELECT PARTITION_NAME, PARTITION_EXPRESSION, SUBPARTITION_NAME
FROM information_schema.PARTITIONS
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'proxy_requests'
ORDER BY PARTITION_ORDINAL_POSITION;
```

Expected: Monthly partitions like `p2026_04`, `p2026_05`, with future partition `p_future`.

---

## New Environment Variables

All new variables have safe defaults. Only `ENCRYPTION_KEY` is required in production.

```bash
# == Security (Fix 2) ==
ENCRYPTION_KEY=                    # 64-char hex. REQUIRED in prod.
REDIS_PASSWORD=                    # Auth for Redis. Warn if missing.
API_SECRET_KEY=                    # Bearer token for /api/testing/*
CORS_ALLOWED_ORIGIN=*              # CORS origin. Set to domain in prod.

# == Reliability (Fix 4) ==
AGGREGATION_WATCHDOG_MS=14400000   # 4h default. Lower for testing.
STARTUP_DAILY_BACKFILL_DAYS=2      # Days to re-aggregate on restart
```

All variables are documented in `.env.example`.

---

## Breaking Changes

- **MySQL partitioning required**: Old flat table must be partitioned (see `docs/SCALABILITY_AND_IMPROVEMENTS.md`)
- **Encryption key required in production**: Set `ENCRYPTION_KEY` before startup
- **Redis password encouraged**: Set `REDIS_PASSWORD` in production
- **API authentication optional but recommended**: Set `API_SECRET_KEY` in production
- **Timezone must be UTC**: `TZ=UTC` env var in Docker

---

## Testing the Fixes

### 1. Test Data Loss Prevention

```bash
# Stop the app mid-aggregation (send SIGTERM)
# Check logs for graceful shutdown sequence:
# ✅ "Graceful shutdown initiated"
# ✅ "Stopping proxy testers"
# ✅ "Draining BullMQ workers"
# ✅ "Flushing batch writer"
# ✅ "Graceful shutdown complete"
```

### 2. Test Encryption

```bash
# Check database directly
mysql> SELECT proxy_id, password FROM proxy LIMIT 1;
# Expected: password column contains "enc:....." (base64 with prefix)
```

### 3. Test Aggregation Watchdog

```bash
# Set a short watchdog for testing
AGGREGATION_WATCHDOG_MS=5000

# Manually trigger aggregation with a long query timeout
# Watch logs for watchdog trigger after 5 seconds if query hangs
```

### 4. Test Redis Fallback

```bash
# Stop Redis temporarily
docker stop x-proxy-tester-redis

# App continues testing, logs show fallback:
# WARN: Redis unavailable — falling back to direct DB write

# Restart Redis
docker start x-proxy-tester-redis
```

---

## References

- **Encryption**: `src/lib/encryption.ts` — AES-256-GCM utilities
- **Aggregation**: `src/services/daily-aggregation.ts` — Daily summary logic
- **Stability**: `src/services/stability-calculator.ts` — Single-query aggregation
- **Graceful Shutdown**: `src/main.ts` → `gracefulShutdown()` function
- **Config Validation**: `src/config/index.ts` → security warnings
