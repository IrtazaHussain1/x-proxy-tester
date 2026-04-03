# Scalability & Improvement Analysis

**Date:** 2026-04-03
**Context:** MySQL performance degradation, storage exhaustion, slow Grafana queries at scale (1,000–10,000 proxies)

---

## The Real Problem (Root Cause)

The cron job deleting old data is a band-aid. The actual issue is **architectural**:

```
1000 proxies × 1 request / 5 seconds = 200 writes/second
                                      = 17.3M rows/day
                                      = 6.3 billion rows/year
```

Every single heartbeat is logged at maximum granularity, forever, into a single flat table.
No amount of deletion scheduling fixes this cleanly — you need to stop producing waste at
the source and query the right layer of data.

---

## Why the Cron Delete is the Wrong Approach

```sql
-- What the cron job does:
DELETE FROM proxy_requests WHERE timestamp < DATE_SUB(NOW(), INTERVAL 30 DAY);
```

Problems with this approach:

- `DELETE` on millions of rows **locks the table** — writes and reads stall while it runs
- MySQL writes to the undo log for every deleted row — doubles the I/O
- Runs as a spike (once a day, massive operation) rather than steady-state
- Fragmentation: deleted rows leave gaps, the table file does not shrink without `OPTIMIZE TABLE`, which locks even longer
- If it falls behind once, it cascades

---

## What Should Be Done

### Fix 1 — MySQL Partitioning (Replaces the cron delete entirely)

Partition `proxy_requests` by month. Dropping old data becomes:

```sql
ALTER TABLE proxy_requests DROP PARTITION p2025_01;
```

This is **instantaneous** — it just removes a file. No locks, no undo log, no fragmentation.
Grafana queries automatically skip irrelevant partitions, making them 10–50× faster.

```sql
ALTER TABLE proxy_requests PARTITION BY RANGE (UNIX_TIMESTAMP(timestamp)) (
  PARTITION p2025_01 VALUES LESS THAN (UNIX_TIMESTAMP('2025-02-01')),
  PARTITION p2025_02 VALUES LESS THAN (UNIX_TIMESTAMP('2025-03-01')),
  PARTITION p2025_03 VALUES LESS THAN (UNIX_TIMESTAMP('2025-04-01')),
  PARTITION p_future  VALUES LESS THAN MAXVALUE
);
```

A MySQL Event (DB-native scheduler, no external cron needed) handles monthly rotation:

```sql
CREATE EVENT drop_old_partitions
ON SCHEDULE EVERY 1 MONTH
DO
  ALTER TABLE proxy_requests DROP PARTITION p2025_01; -- roll forward monthly
```

> **On triggers** — triggers are the wrong tool for data expiry. They fire on every INSERT
> and add per-row overhead to the write path. Use partitions + MySQL Events instead.

---

### Fix 2 — Adaptive Logging Frequency

Currently every proxy is tested every 5 seconds regardless of health. That is the right
frequency for a failing phone. It is 6× over-logged for a phone that has been stable for 3 days.

```
Stable phone, 30s interval:  2,880 rows/day   (86% reduction)
Failing phone, 5s interval:  17,280 rows/day  (keeps full resolution where it matters)
```

Logic: if `stabilityStatus = 'Stable'` and `errorCount(last 1h) = 0`, reduce test interval
to 30s. If any failure occurs, immediately drop back to 5s.

Write volume reduction at 1,000 proxies assuming 70% are stable: **~70% fewer rows written daily**.

---

### Fix 3 — Hot/Cold Query Routing

The daily aggregation table (`proxy_requests_daily_summary`) is now active. Grafana dashboards
should route queries based on data age:

```sql
-- For data < 24 hours old: query raw table (full resolution)
SELECT ... FROM proxy_requests WHERE timestamp > NOW() - INTERVAL 1 DAY

-- For data > 24 hours old: query summary table (pre-aggregated, tiny)
SELECT ... FROM proxy_requests_daily_summary WHERE day < CURDATE()
```

Most slow Grafana queries are historical (7-day, 30-day views) hitting 100M+ raw rows when
they could be hitting a summary table with ~1,000 rows. This alone fixes most of the
Grafana slowness.

---

### Fix 4 — Separate Read and Write Traffic

Grafana (analytics reads) and the continuous tester (constant writes) hit the same MySQL
instance. They compete for I/O, buffer pool, and connection pool. A MySQL read replica
separates these workloads:

```yaml
# docker-compose addition
mysql-replica:
  image: mysql:8
  environment:
    MYSQL_REPLICA_HOST: mysql-primary
  # Grafana datasource points to replica
  # Application writes go to primary only
```

---

## Presenting to the Client

### Problems Identified

1. **Storage exhaustion** — Raw request table grows 17M rows/day with no structural bound.
   Cron deletion is reactive, causes table locks, and does not reduce fragmentation.

2. **Slow Grafana queries** — Dashboards query raw request data for 7/30-day windows,
   scanning tens of millions of rows when 99% of that data is redundant for analytics.

3. **Write/read contention** — Analytics queries and proxy testing writes compete on the
   same database instance, each degrading the other.

4. **Uniform logging granularity** — Healthy, stable proxies are logged at the same
   frequency as failing ones, generating 6× more data than needed for reliable monitoring.

---

### Improvements Already Made

| Improvement | Impact |
|---|---|
| Enabled daily aggregation service | Historical data pre-aggregated per phone per day — monthly analytics now fast without scanning raw tables |
| Reduced active Grafana dashboards from 17 to 11 | Less query load on DB, cleaner operational view — 5 redundant dashboards archived |
| Added Server Overview dashboard | First visibility into relay server-level health — phones grouped by server, cascading failure detection at a glance |
| Added `/api/analytics/problems` endpoint | Real-time programmatic access to problem phones — enables future automation without querying Grafana |
| Added Proxy Analytics dashboard | Unique IPs per phone/server, IP diversity score, traffic stats per phone, peak hour patterns, phone reliability ranking |

---

### Proposed Next Improvements

| Improvement | What It Fixes | Effort |
|---|---|---|
| MySQL table partitioning on `proxy_requests` | Replaces cron delete with instant partition drops, speeds up all time-range queries by 10–50× | 1–2 days |
| Adaptive logging frequency | Reduces write volume ~70% by slowing test interval for stable proxies | 2–3 days |
| Hot/cold query routing in dashboards | Grafana historical panels query summary table — eliminates slow dashboard queries | 1 day |
| MySQL read replica for Grafana | Separates analytics reads from testing writes, eliminates I/O contention | 1 day |
| MySQL Event Scheduler for partition management | Replaces external cron with DB-native scheduling, more reliable and atomic | 2 hours |

---

### Expected Outcomes

- Storage growth reduced **~70–80%** through adaptive logging + partition-based retention
- Grafana query times drop from **seconds to milliseconds** for historical panels
- **Zero table-lock spikes** from DELETE operations
- Write throughput headroom to scale to **5,000–10,000 proxies** without DB changes

---

## Why Not InfluxDB?

The migration cost (9–14 engineering weeks + ongoing dual-DB complexity) does not pay off
at current scale. The data model is not purely time-series — `proxies`, `ip_rotations`,
`rotation_cycles`, and `duplicate_ip_*` tables are relational and cannot move to InfluxDB.
You would end up running two databases with no net benefit.

The above four fixes (partitioning + adaptive logging + query routing + read replica)
deliver equivalent or better performance improvements at a fraction of the cost and risk.

If scale reaches 50,000+ proxies with 250,000+ writes/second and MySQL genuinely cannot
keep up, the correct migration path is **TimescaleDB** (PostgreSQL extension, SQL-compatible,
Prisma-compatible, Grafana-compatible) — not InfluxDB.
