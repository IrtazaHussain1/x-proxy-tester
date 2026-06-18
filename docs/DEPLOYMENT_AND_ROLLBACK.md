# Deployment & Rollback Guide

Branch: `improve/db-partition-summary-table`
Date: 2026-04-07

---

## What This Branch Changes

### Code Changes (reversible — git checkout)
| File | Change |
|---|---|
| `src/services/continuous-proxy-tester.ts` | Removed `waitForExclusiveDbJobsToFinish()` from write path — writes never pause for background jobs |
| `src/services/daily-aggregation.ts` | App-side aggregation disabled by default (`ENABLE_DAILY_AGGREGATION_ON_START=false`). MySQL EVENT handles it |
| `src/services/archival.ts` | Removed `proxy_requests` row-by-row delete. Only `speed_tests` cleanup remains. MySQL partition EVENT handles `proxy_requests` retention |
| `src/lib/db.ts` | Three separate connection pools: `writeDb` (20), `backgroundDb` (8), `prisma` (15) |
| `src/lib/db-pool-config.ts` | Added `getDatabaseUrlWithConnectionLimit()` helper |
| `src/lib/batch-writer.ts` | Fixed silent data loss bug — failed batches re-queued instead of dropped |

### DB Migrations (not reversible without manual work)
| Migration | What it does |
|---|---|
| `20260406000000_add_proxy_requests_partitioning` | Partitions `proxy_requests` by month (RANGE COLUMNS on timestamp) |
| `20260406000001_update_partition_retention_and_cleanup` | Creates `manage_proxy_requests_partitions` monthly EVENT |
| `20260406000002_fix_aggregation_partition_pruning` | Fixes stored proc to use range predicates (partition pruning) |
| `20260406000003_add_daily_aggregation_event` | Creates `daily_aggregate_summary` EVENT at 02:30 AM |
| `20260407000000_drop_redundant_proxy_requests_indexes` | Drops 7 redundant indexes on `proxy_requests` (60% less write amplification) |

---

## Deploying to Production

### Prerequisites
1. Confirm MySQL `event_scheduler` is ON on prod:
```sql
SHOW VARIABLES LIKE 'event_scheduler';
-- If OFF:
SET GLOBAL event_scheduler = ON;
-- Make permanent in mysql.cnf: event_scheduler = ON
```

2. Confirm partitioning is NOT already applied on prod (avoid re-running):
```sql
SELECT PARTITION_NAME FROM information_schema.PARTITIONS
WHERE TABLE_NAME = 'proxy_requests' LIMIT 1;
```

### Step 1 — Apply DB Migrations

**If prod DB has NO partitioning yet (fresh):**
```bash
npx prisma migrate deploy
```
> ⚠️ The partitioning migration (`20260406000000`) rebuilds the entire `proxy_requests` table.
> Schedule during a maintenance window. With 1M+ rows it takes 30–60 min.
> Stop the app before running to avoid write contention during the rebuild.

**If prod DB already has partitioning (same as dev):**
```bash
# Mark the already-applied migrations as done without re-running them
npx prisma migrate resolve --applied 20260406000000_add_proxy_requests_partitioning
npx prisma migrate resolve --applied 20260406000001_update_partition_retention_and_cleanup
npx prisma migrate resolve --applied 20260406000002_fix_aggregation_partition_pruning
npx prisma migrate resolve --applied 20260406000003_add_daily_aggregation_event

# Apply only the index drop (fast — seconds, online in MySQL 8.0)
npx prisma migrate deploy
```

### Step 2 — Set Environment Variables
Add to prod `.env`:
```
# Connection pools (separate write / background / read)
DB_WRITE_CONNECTION_LIMIT=20
DB_BACKGROUND_CONNECTION_LIMIT=8
DB_CONNECTION_LIMIT=15

# Aggregation handled by MySQL EVENT at 02:30 AM — disable app service
ENABLE_DAILY_AGGREGATION_ON_START=false

# Archival: proxy_requests handled by partition EVENT, only speed_tests cleaned by app
ENABLE_ARCHIVAL=true
```

### Step 3 — Deploy Code
```bash
git checkout improve/db-partition-summary-table
npm install
npm run build
# restart app (pm2 restart / docker restart / etc.)
```

### Step 4 — Verify After Deploy
```sql
-- Events are running
SHOW EVENTS;
-- Expect: daily_aggregate_summary ENABLED, manage_proxy_requests_partitions ENABLED

-- Indexes were dropped
SHOW INDEX FROM proxy_requests;
-- Expect: 5 indexes only (PRIMARY, proxy_id_timestamp, proxy_timestamp_source, timestamp, outbound_ip)

-- Partitions exist
SELECT PARTITION_NAME FROM information_schema.PARTITIONS
WHERE TABLE_NAME = 'proxy_requests'
ORDER BY PARTITION_NAME;

-- Summary table has data (after 02:30 AM next day)
SELECT day, COUNT(*) as proxies, SUM(total_requests) as requests
FROM proxy_requests_daily_summary
GROUP BY day ORDER BY day DESC LIMIT 7;
```

---

## Rollback

### Code Rollback (instant — no DB changes needed)
The DB schema is fully backwards compatible with the old code on `main`.

```bash
git checkout main
npm run build
# restart app
```

Set env vars back:
```
# Remove or unset these (revert to old single-pool behaviour)
DB_WRITE_CONNECTION_LIMIT=
DB_BACKGROUND_CONNECTION_LIMIT=
DB_CONNECTION_LIMIT=60

# Re-enable app-level services if desired
ENABLE_DAILY_AGGREGATION_ON_START=true
ENABLE_ARCHIVAL=true
```

> The partitioning and index changes on the DB do not break `main` branch code.
> `main` works fine against the new schema.

---

### DB Rollback — Index Drop (reversible)

If you need the dropped indexes back for any reason:

```sql
ALTER TABLE proxy_requests
  ADD INDEX proxy_requests_timestamp_proxy_id_idx (timestamp, proxy_id),
  ADD INDEX proxy_requests_status_idx (status),
  ADD INDEX proxy_requests_expected_ip_idx (expected_ip),
  ADD INDEX proxy_requests_ip_changed_idx (ip_changed),
  ADD INDEX proxy_requests_source_idx (source),
  ADD INDEX proxy_requests_created_at_idx (created_at),
  ADD INDEX proxy_requests_updated_at_idx (updated_at);
```

Then mark the migration as rolled back in Prisma:
```bash
npx prisma migrate resolve --rolled-back 20260407000000_drop_redundant_proxy_requests_indexes
```

---

### DB Rollback — Partitioning (NOT recommended)

Reversing partitioning requires a full table rebuild (same cost as applying it).
Only do this if there is a critical data issue.

```sql
-- WARNING: Full table rebuild. Takes 30-60 min on large tables.
-- Stop the app first.
ALTER TABLE proxy_requests REMOVE PARTITIONING;
```

Then:
```bash
npx prisma migrate resolve --rolled-back 20260406000000_add_proxy_requests_partitioning
npx prisma migrate resolve --rolled-back 20260406000001_update_partition_retention_and_cleanup
npx prisma migrate resolve --rolled-back 20260406000002_fix_aggregation_partition_pruning
npx prisma migrate resolve --rolled-back 20260406000003_add_daily_aggregation_event
```

Also drop the events:
```sql
DROP EVENT IF EXISTS daily_aggregate_summary;
DROP EVENT IF EXISTS manage_proxy_requests_partitions;
```

---

## Quick Reference

| Situation | Action |
|---|---|
| App has bugs on prod | `git checkout main` + restart — DB stays as-is |
| Index drop caused query issues | Re-add indexes with ALTER TABLE above |
| Aggregation not running | Check `SHOW EVENTS` — ensure `event_scheduler = ON` |
| Summary table empty | `CALL aggregate_daily_summary(CURDATE() - INTERVAL 1 DAY)` |
| Partition missing for future month | Monthly EVENT on 1st handles it automatically |
| Migration out of sync | `npx prisma migrate resolve --applied <name>` |
