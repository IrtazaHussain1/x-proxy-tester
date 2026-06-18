-- Migration: Add RANGE COLUMNS partitioning to proxy_requests by month
--
-- WHY: Batch DELETE on millions of rows locks the table and causes I/O spikes.
--      Partition DROP is instant (removes a file), no locks, no undo log.
--      Grafana time-range queries automatically skip irrelevant partitions (10-50x faster).
--
-- IMPORTANT NOTES:
--   1. MySQL does NOT support foreign keys on partitioned tables — the FK is dropped here.
--      Referential integrity is maintained by the application (archival service).
--   2. PK must include the partition key (timestamp) — changed from (id) to (id, timestamp).
--      UUIDs remain globally unique so this has no practical impact.
--   3. Uses RANGE COLUMNS (timestamp) not RANGE (UNIX_TIMESTAMP(timestamp)) — avoids
--      the "timezone-dependent expression" error. RANGE COLUMNS accepts datetime values directly.
--   4. This ALTER TABLE rewrites all data — may take time on large tables.
--      Run during low-traffic window if table is large.
--
-- APPLY WITH (bypasses shadow DB issue):
--   npx prisma db execute --file prisma/migrations/20260406000000_add_proxy_requests_partitioning/migration.sql --schema prisma/schema.prisma
--   npx prisma migrate resolve --applied 20260406000000_add_proxy_requests_partitioning

-- ============================================================
-- Step 1: Drop FK constraint (incompatible with partitioned tables)
--         Uses conditional check since FK may already be absent.
-- ============================================================
SET @fk_exists = (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'proxy_requests'
    AND CONSTRAINT_NAME = 'proxy_requests_proxy_id_fkey'
    AND CONSTRAINT_TYPE = 'FOREIGN KEY'
);
SET @drop_fk = IF(@fk_exists > 0,
  'ALTER TABLE proxy_requests DROP FOREIGN KEY proxy_requests_proxy_id_fkey',
  'SELECT 1'
);
PREPARE stmt FROM @drop_fk;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ============================================================
-- Step 2: Change PK from (id) to (id, timestamp)
--         Required: MySQL partition key must be in every unique/PK index
-- ============================================================
ALTER TABLE proxy_requests
  DROP PRIMARY KEY,
  ADD PRIMARY KEY (id, timestamp);

-- ============================================================
-- Step 3: Apply RANGE COLUMNS partitioning by month on timestamp
--         RANGE COLUMNS accepts datetime strings directly — no function call,
--         no timezone-dependency error.
--         Covers from Dec 2024 (first migration date) through future.
--         p_future catches all rows beyond the last named partition.
-- ============================================================
ALTER TABLE proxy_requests
  PARTITION BY RANGE COLUMNS (timestamp) (
    PARTITION p2024_12 VALUES LESS THAN ('2025-01-01 00:00:00'),
    PARTITION p2025_01 VALUES LESS THAN ('2025-02-01 00:00:00'),
    PARTITION p2025_02 VALUES LESS THAN ('2025-03-01 00:00:00'),
    PARTITION p2025_03 VALUES LESS THAN ('2025-04-01 00:00:00'),
    PARTITION p2025_04 VALUES LESS THAN ('2025-05-01 00:00:00'),
    PARTITION p2025_05 VALUES LESS THAN ('2025-06-01 00:00:00'),
    PARTITION p2025_06 VALUES LESS THAN ('2025-07-01 00:00:00'),
    PARTITION p2025_07 VALUES LESS THAN ('2025-08-01 00:00:00'),
    PARTITION p2025_08 VALUES LESS THAN ('2025-09-01 00:00:00'),
    PARTITION p2025_09 VALUES LESS THAN ('2025-10-01 00:00:00'),
    PARTITION p2025_10 VALUES LESS THAN ('2025-11-01 00:00:00'),
    PARTITION p2025_11 VALUES LESS THAN ('2025-12-01 00:00:00'),
    PARTITION p2025_12 VALUES LESS THAN ('2026-01-01 00:00:00'),
    PARTITION p2026_01 VALUES LESS THAN ('2026-02-01 00:00:00'),
    PARTITION p2026_02 VALUES LESS THAN ('2026-03-01 00:00:00'),
    PARTITION p2026_03 VALUES LESS THAN ('2026-04-01 00:00:00'),
    PARTITION p2026_04 VALUES LESS THAN ('2026-05-01 00:00:00'),
    PARTITION p2026_05 VALUES LESS THAN ('2026-06-01 00:00:00'),
    PARTITION p2026_06 VALUES LESS THAN ('2026-07-01 00:00:00'),
    PARTITION p_future  VALUES LESS THAN (MAXVALUE)
  );

-- ============================================================
-- Step 4: Monthly partition management EVENT
--         Runs on the 1st of each month at 2 AM:
--           - Carves the month-after-next out of p_future (keeps p_future lean)
--           - Drops the partition 3 months ago (data already in daily_summary)
-- ============================================================
DROP EVENT IF EXISTS manage_proxy_requests_partitions;

CREATE EVENT manage_proxy_requests_partitions
  ON SCHEDULE EVERY 1 MONTH
  STARTS (DATE_FORMAT(DATE_ADD(CURDATE(), INTERVAL 1 MONTH), '%Y-%m-01 02:00:00'))
  ON COMPLETION PRESERVE
  DO BEGIN
    -- Carve next+2 month partition out of p_future
    SET @new_part_name = CONCAT('p', DATE_FORMAT(DATE_ADD(NOW(), INTERVAL 2 MONTH), '%Y_%m'));
    SET @new_part_bound = DATE_FORMAT(
      DATE_ADD(LAST_DAY(DATE_ADD(NOW(), INTERVAL 2 MONTH)), INTERVAL 1 DAY),
      '%Y-%m-%d 00:00:00'
    );
    SET @reorganize_sql = CONCAT(
      'ALTER TABLE proxy_requests REORGANIZE PARTITION p_future INTO (',
        'PARTITION ', @new_part_name, ' VALUES LESS THAN (''', @new_part_bound, '''),',
        'PARTITION p_future VALUES LESS THAN (MAXVALUE)',
      ')'
    );
    PREPARE stmt FROM @reorganize_sql;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;

    -- Drop partition from 3 months ago (raw data already aggregated into daily_summary)
    SET @old_part_name = CONCAT('p', DATE_FORMAT(DATE_SUB(NOW(), INTERVAL 3 MONTH), '%Y_%m'));
    SET @drop_sql = CONCAT('ALTER TABLE proxy_requests DROP PARTITION IF EXISTS ', @old_part_name);
    PREPARE stmt FROM @drop_sql;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END;
