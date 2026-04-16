-- Add device and computed server metadata to daily aggregate summary.
-- This migration is idempotent to support mixed environments.

SET @db = DATABASE();

SET @sql = IF(
  (SELECT COUNT(*)
   FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = @db
     AND TABLE_NAME = 'proxy_requests_daily_summary'
     AND COLUMN_NAME = 'device_name') = 0,
  'ALTER TABLE proxy_requests_daily_summary ADD COLUMN device_name VARCHAR(255) NULL AFTER proxy_id',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql = IF(
  (SELECT COUNT(*)
   FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = @db
     AND TABLE_NAME = 'proxy_requests_daily_summary'
     AND COLUMN_NAME = 'server_name') = 0,
  'ALTER TABLE proxy_requests_daily_summary ADD COLUMN server_name VARCHAR(32) NULL AFTER device_name',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql = IF(
  (SELECT COUNT(*)
   FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = @db
     AND TABLE_NAME = 'proxy_requests_daily_summary'
     AND INDEX_NAME = 'idx_proxy_requests_daily_summary_server_name') = 0,
  'CREATE INDEX idx_proxy_requests_daily_summary_server_name ON proxy_requests_daily_summary (server_name)',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
