-- Fix rotation column naming:
-- 1. Rename ip_rotation_continuous_* → ip_rotation_inactive_proxy_*
-- 2. Add NEW ip_rotation_continuous_* columns wired to proxy_requests source='continuous'
-- ALGORITHM=INSTANT used throughout — zero table rebuild, metadata-only on MySQL 8.0+
SET @db = DATABASE();

-- Rename continuous_success → inactive_proxy_success
SET @sql = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'proxy_requests_daily_summary'
     AND COLUMN_NAME = 'ip_rotation_continuous_success_count') > 0
  AND
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'proxy_requests_daily_summary'
     AND COLUMN_NAME = 'ip_rotation_inactive_proxy_success_count') = 0,
  'ALTER TABLE proxy_requests_daily_summary CHANGE ip_rotation_continuous_success_count ip_rotation_inactive_proxy_success_count INT NOT NULL DEFAULT 0, ALGORITHM=INSTANT',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Rename continuous_failure → inactive_proxy_failure
SET @sql = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'proxy_requests_daily_summary'
     AND COLUMN_NAME = 'ip_rotation_continuous_failure_count') > 0
  AND
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'proxy_requests_daily_summary'
     AND COLUMN_NAME = 'ip_rotation_inactive_proxy_failure_count') = 0,
  'ALTER TABLE proxy_requests_daily_summary CHANGE ip_rotation_continuous_failure_count ip_rotation_inactive_proxy_failure_count INT NOT NULL DEFAULT 0, ALGORITHM=INSTANT',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Add new ip_rotation_continuous_success_count
SET @sql = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'proxy_requests_daily_summary'
     AND COLUMN_NAME = 'ip_rotation_continuous_success_count') = 0,
  'ALTER TABLE proxy_requests_daily_summary ADD COLUMN ip_rotation_continuous_success_count INT NOT NULL DEFAULT 0 AFTER ip_rotation_inactive_proxy_failure_count, ALGORITHM=INSTANT',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Add new ip_rotation_continuous_failure_count
SET @sql = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'proxy_requests_daily_summary'
     AND COLUMN_NAME = 'ip_rotation_continuous_failure_count') = 0,
  'ALTER TABLE proxy_requests_daily_summary ADD COLUMN ip_rotation_continuous_failure_count INT NOT NULL DEFAULT 0 AFTER ip_rotation_continuous_success_count, ALGORITHM=INSTANT',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
