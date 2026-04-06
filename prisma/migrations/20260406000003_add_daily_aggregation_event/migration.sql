-- Migration: Add DB-level daily aggregation EVENT
--
-- Creates a MySQL EVENT that calls aggregate_daily_summary() every day at 02:30 AM.
-- This moves the scheduling responsibility from the Node.js app to the database,
-- so aggregation runs even if the app is down or restarted.
--
-- The Node.js daily-aggregation service (AGGREGATION_SCHEDULE) still runs as a
-- secondary trigger and provides the startup backfill — both are safe to run
-- concurrently because aggregate_daily_summary uses INSERT ... ON DUPLICATE KEY UPDATE.
--
-- APPLY WITH:
--   npx prisma db execute --file prisma/migrations/20260406000003_add_daily_aggregation_event/migration.sql --schema prisma/schema.prisma
--   npx prisma migrate resolve --applied 20260406000003_add_daily_aggregation_event

DROP EVENT IF EXISTS daily_aggregate_summary;

CREATE EVENT daily_aggregate_summary
  ON SCHEDULE EVERY 1 DAY
  STARTS (DATE_FORMAT(CURDATE(), '%Y-%m-%d 02:30:00') + INTERVAL IF(NOW() < DATE_FORMAT(CURDATE(), '%Y-%m-%d 02:30:00'), 0, 1) DAY)
  ON COMPLETION PRESERVE
  COMMENT 'Aggregates yesterday raw proxy_requests into proxy_requests_daily_summary'
  DO CALL aggregate_daily_summary(CURDATE() - INTERVAL 1 DAY);
