-- Migration: Extend proxy_requests_daily_summary + add MySQL EVENT cleanup
-- MySQL-compatible: no ADD COLUMN IF NOT EXISTS, no CREATE INDEX IF NOT EXISTS, no DELIMITER.
-- aggregate_daily_summary stored procedure: prisma/migrations/20260404120000_add_aggregate_daily_summary_procedure/

-- ============================================
-- Step 1: Ensure base table exists
-- ============================================

SET @db := DATABASE();

SET @table_exists := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'proxy_requests_daily_summary'
);
SET @sql := IF(@table_exists = 0,
  'CREATE TABLE proxy_requests_daily_summary (
     day DATE NOT NULL,
     proxy_id VARCHAR(255) NOT NULL,
     location VARCHAR(255) NULL,
     total_requests INT DEFAULT 0,
     success_count INT DEFAULT 0,
     failure_count INT DEFAULT 0,
     avg_response_time_ms DECIMAL(10,2) NULL,
     min_response_time_ms INT NULL,
     max_response_time_ms INT NULL,
     p50_response_time_ms INT NULL,
     p95_response_time_ms INT NULL,
     p99_response_time_ms INT NULL,
     timeout_count INT DEFAULT 0,
     connection_error_count INT DEFAULT 0,
     http_error_count INT DEFAULT 0,
     dns_error_count INT DEFAULT 0,
     rotation_count INT DEFAULT 0,
     avg_download_speed_mbps DECIMAL(10,2) NULL,
     avg_upload_speed_mbps DECIMAL(10,2) NULL,
     max_download_speed_mbps DECIMAL(10,2) NULL,
     max_upload_speed_mbps DECIMAL(10,2) NULL,
     min_download_speed_mbps DECIMAL(10,2) NULL,
     min_upload_speed_mbps DECIMAL(10,2) NULL,
     unique_ips_count INT DEFAULT 0,
     created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
     updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
     PRIMARY KEY (day, proxy_id),
     INDEX idx_day (day),
     INDEX idx_proxy_id_day (proxy_id, day),
     INDEX idx_location (location)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci',
  'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ============================================
-- Step 2: New columns (only if missing)
-- ============================================

SET @exists := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'proxy_requests_daily_summary' AND COLUMN_NAME = 'relay_server_id'
);
SET @sql := IF(@exists = 0,
  'ALTER TABLE proxy_requests_daily_summary ADD COLUMN relay_server_id VARCHAR(255) NULL AFTER location',
  'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @exists := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'proxy_requests_daily_summary' AND COLUMN_NAME = 'relay_server_ip'
);
SET @sql := IF(@exists = 0,
  'ALTER TABLE proxy_requests_daily_summary ADD COLUMN relay_server_ip VARCHAR(45) NULL AFTER relay_server_id',
  'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @exists := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'proxy_requests_daily_summary' AND COLUMN_NAME = 'success_rate_pct'
);
SET @sql := IF(@exists = 0,
  'ALTER TABLE proxy_requests_daily_summary ADD COLUMN success_rate_pct DECIMAL(5,2) NULL AFTER failure_count',
  'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @exists := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'proxy_requests_daily_summary' AND COLUMN_NAME = 'ip_diversity_score'
);
SET @sql := IF(@exists = 0,
  'ALTER TABLE proxy_requests_daily_summary ADD COLUMN ip_diversity_score DECIMAL(5,2) NULL AFTER unique_ips_count',
  'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- p50/p95/p99 (may already exist from 20250112000001)
SET @col_exists := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = @db
    AND TABLE_NAME = 'proxy_requests_daily_summary'
    AND COLUMN_NAME = 'p50_response_time_ms'
);
SET @sql := IF(@col_exists = 0,
  'ALTER TABLE proxy_requests_daily_summary
     ADD COLUMN p50_response_time_ms INT NULL AFTER max_response_time_ms,
     ADD COLUMN p95_response_time_ms INT NULL AFTER p50_response_time_ms,
     ADD COLUMN p99_response_time_ms INT NULL AFTER p95_response_time_ms',
  'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ============================================
-- Step 3: Indexes (only if missing — MySQL has no CREATE INDEX IF NOT EXISTS)
-- ============================================

SET @idx_exists := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'proxy_requests_daily_summary' AND INDEX_NAME = 'idx_relay_server_id'
);
SET @sql := IF(@idx_exists = 0,
  'CREATE INDEX idx_relay_server_id ON proxy_requests_daily_summary (relay_server_id)',
  'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @idx_exists := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'proxy_requests_daily_summary' AND INDEX_NAME = 'idx_day_relay_server'
);
SET @sql := IF(@idx_exists = 0,
  'CREATE INDEX idx_day_relay_server ON proxy_requests_daily_summary (day, relay_server_id)',
  'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ============================================
-- Step 4: EVENT scheduler cleanup (enable event_scheduler in my.cnf or SET GLOBAL if permitted)
-- ============================================

DROP EVENT IF EXISTS cleanup_old_proxy_requests;

CREATE EVENT cleanup_old_proxy_requests
  ON SCHEDULE EVERY 1 DAY
  STARTS (TIMESTAMP(CURRENT_DATE) + INTERVAL 3 HOUR)
  ON COMPLETION PRESERVE
  DO DELETE FROM proxy_requests WHERE timestamp < DATE_SUB(NOW(), INTERVAL 31 DAY) LIMIT 5000;

DROP EVENT IF EXISTS cleanup_old_speed_tests;

CREATE EVENT cleanup_old_speed_tests
  ON SCHEDULE EVERY 1 DAY
  STARTS (TIMESTAMP(CURRENT_DATE) + INTERVAL 3 HOUR + INTERVAL 5 MINUTE)
  ON COMPLETION PRESERVE
  DO DELETE FROM speed_tests WHERE timestamp < DATE_SUB(NOW(), INTERVAL 31 DAY) LIMIT 5000;
