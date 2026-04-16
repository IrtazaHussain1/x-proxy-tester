-- Add ip_rotation_XXX outcome counters to daily aggregate summary.
-- Counters are split into periodic vs continuous (non-periodic) groups.
SET @db = DATABASE();

SET @sql = IF(
  (SELECT COUNT(*)
   FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = @db
     AND TABLE_NAME = 'proxy_requests_daily_summary'
     AND COLUMN_NAME = 'ip_rotation_periodic_success_count') = 0,
  'ALTER TABLE proxy_requests_daily_summary ADD COLUMN ip_rotation_periodic_success_count INT NOT NULL DEFAULT 0 AFTER rotation_count',
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
     AND COLUMN_NAME = 'ip_rotation_periodic_failure_count') = 0,
  'ALTER TABLE proxy_requests_daily_summary ADD COLUMN ip_rotation_periodic_failure_count INT NOT NULL DEFAULT 0 AFTER ip_rotation_periodic_success_count',
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
     AND COLUMN_NAME = 'ip_rotation_continuous_success_count') = 0,
  'ALTER TABLE proxy_requests_daily_summary ADD COLUMN ip_rotation_continuous_success_count INT NOT NULL DEFAULT 0 AFTER ip_rotation_periodic_failure_count',
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
     AND COLUMN_NAME = 'ip_rotation_continuous_failure_count') = 0,
  'ALTER TABLE proxy_requests_daily_summary ADD COLUMN ip_rotation_continuous_failure_count INT NOT NULL DEFAULT 0 AFTER ip_rotation_continuous_success_count',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
