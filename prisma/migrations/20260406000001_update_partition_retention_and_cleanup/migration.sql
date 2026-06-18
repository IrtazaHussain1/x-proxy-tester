-- Migration: 1-month partition retention with aggregation safety check
--
-- CHANGES:
--   1. Drop old batch-DELETE EVENTs — redundant now that partitions handle cleanup.
--   2. Recreate manage_proxy_requests_partitions EVENT with:
--        - 1-month retention: drops partition from 2 months ago (not 3)
--        - Aggregation safety: aggregates any missing days BEFORE dropping the partition
--
-- HOW RETENTION WORKS:
--   Today = April 2026
--   Keep:  p2026_04 (current) + p2026_03 (last month)
--   Drop:  p2026_02 (February — fully > 1 month old, safe to drop after aggregation)
--
-- APPLY WITH:
--   npx prisma db execute --file prisma/migrations/20260406000001_update_partition_retention_and_cleanup/migration.sql --schema prisma/schema.prisma
--   npx prisma migrate resolve --applied 20260406000001_update_partition_retention_and_cleanup

-- ============================================================
-- Step 1: Remove old batch-DELETE EVENTs (replaced by partition DROP)
-- ============================================================
DROP EVENT IF EXISTS cleanup_old_proxy_requests;
DROP EVENT IF EXISTS cleanup_old_speed_tests;

-- ============================================================
-- Step 2: Recreate monthly partition management EVENT
--         - Runs 1st of each month at 02:00
--         - Aggregates any un-aggregated days in the partition before dropping it
--         - Drops partition from 2 months ago (= 1-month raw data retention)
--         - Carves next+2 month out of p_future so query pruning works ahead of time
-- ============================================================
DROP EVENT IF EXISTS manage_proxy_requests_partitions;

CREATE EVENT manage_proxy_requests_partitions
  ON SCHEDULE EVERY 1 MONTH
  STARTS (DATE_FORMAT(DATE_ADD(CURDATE(), INTERVAL 1 MONTH), '%Y-%m-01 02:00:00'))
  ON COMPLETION PRESERVE
  DO BEGIN
    -- ----------------------------------------------------------
    -- Part A: Aggregate any missing days in the partition we are
    --         about to drop (2 months ago) before deleting it.
    --         Inserts into proxy_requests_daily_summary for any
    --         day that has raw rows but no summary row yet.
    -- ----------------------------------------------------------
    SET @drop_month_start = DATE_FORMAT(DATE_SUB(NOW(), INTERVAL 2 MONTH), '%Y-%m-01');
    SET @drop_month_end   = DATE_FORMAT(DATE_SUB(NOW(), INTERVAL 1 MONTH), '%Y-%m-01');

    -- Aggregate each un-summarised day in the partition
    BEGIN
      DECLARE done INT DEFAULT 0;
      DECLARE missing_day DATE;
      DECLARE cur CURSOR FOR
        SELECT DISTINCT DATE(pr.timestamp)
        FROM proxy_requests pr
        WHERE pr.timestamp >= @drop_month_start
          AND pr.timestamp <  @drop_month_end
          AND DATE(pr.timestamp) NOT IN (
            SELECT s.day FROM proxy_requests_daily_summary s
            WHERE s.day >= @drop_month_start AND s.day < @drop_month_end
          );
      DECLARE CONTINUE HANDLER FOR NOT FOUND SET done = 1;

      OPEN cur;
      agg_loop: LOOP
        FETCH cur INTO missing_day;
        IF done THEN LEAVE agg_loop; END IF;
        CALL aggregate_daily_summary(missing_day);
      END LOOP;
      CLOSE cur;
    END;

    -- ----------------------------------------------------------
    -- Part B: Drop the partition from 2 months ago
    --         (1-month raw data retention)
    -- ----------------------------------------------------------
    SET @old_part = CONCAT('p', DATE_FORMAT(DATE_SUB(NOW(), INTERVAL 2 MONTH), '%Y_%m'));
    SET @drop_sql = CONCAT('ALTER TABLE proxy_requests DROP PARTITION IF EXISTS ', @old_part);
    PREPARE stmt FROM @drop_sql;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;

    -- ----------------------------------------------------------
    -- Part C: Carve next+2 month partition out of p_future so
    --         Grafana queries can prune it ahead of time
    -- ----------------------------------------------------------
    SET @new_part_name  = CONCAT('p', DATE_FORMAT(DATE_ADD(NOW(), INTERVAL 2 MONTH), '%Y_%m'));
    SET @new_part_bound = DATE_FORMAT(
      DATE_ADD(LAST_DAY(DATE_ADD(NOW(), INTERVAL 2 MONTH)), INTERVAL 1 DAY),
      '%Y-%m-%d 00:00:00'
    );
    SET @reorg_sql = CONCAT(
      'ALTER TABLE proxy_requests REORGANIZE PARTITION p_future INTO (',
        'PARTITION ', @new_part_name, ' VALUES LESS THAN (''', @new_part_bound, '''),',
        'PARTITION p_future VALUES LESS THAN (MAXVALUE)',
      ')'
    );
    PREPARE stmt FROM @reorg_sql;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END;
