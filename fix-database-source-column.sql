-- Fix: Add missing 'source' column to proxy_requests table
-- Run this on production to fix the database schema issue

USE xproxy_tester;

-- Check if column already exists (safe to run multiple times)
SET @col_exists = (
  SELECT COUNT(*) 
  FROM INFORMATION_SCHEMA.COLUMNS 
  WHERE TABLE_SCHEMA = 'xproxy_tester' 
    AND TABLE_NAME = 'proxy_requests' 
    AND COLUMN_NAME = 'source'
);

-- Add column if it doesn't exist
SET @sql = IF(@col_exists = 0,
  'ALTER TABLE `proxy_requests` ADD COLUMN `source` VARCHAR(191) NULL DEFAULT ''continuous''',
  'SELECT ''Column source already exists'' AS message'
);

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Add index if it doesn't exist
SET @idx_exists = (
  SELECT COUNT(*) 
  FROM INFORMATION_SCHEMA.STATISTICS 
  WHERE TABLE_SCHEMA = 'xproxy_tester' 
    AND TABLE_NAME = 'proxy_requests' 
    AND INDEX_NAME = 'proxy_requests_source_idx'
);

SET @sql2 = IF(@idx_exists = 0,
  'CREATE INDEX `proxy_requests_source_idx` ON `proxy_requests`(`source`)',
  'SELECT ''Index proxy_requests_source_idx already exists'' AS message'
);

PREPARE stmt2 FROM @sql2;
EXECUTE stmt2;
DEALLOCATE PREPARE stmt2;

-- Verify the column was added
SELECT 
  COLUMN_NAME, 
  DATA_TYPE, 
  IS_NULLABLE, 
  COLUMN_DEFAULT
FROM INFORMATION_SCHEMA.COLUMNS 
WHERE TABLE_SCHEMA = 'xproxy_tester' 
  AND TABLE_NAME = 'proxy_requests' 
  AND COLUMN_NAME = 'source';

