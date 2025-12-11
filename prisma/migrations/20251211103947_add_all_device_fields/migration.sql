-- Add all missing Device API fields to proxies table
-- This migration is idempotent - safe to run multiple times
-- It checks if columns exist before adding them

-- Device API ID (numeric ID from API)
SET @col_exists = (
  SELECT COUNT(*) 
  FROM INFORMATION_SCHEMA.COLUMNS 
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'proxies' 
    AND COLUMN_NAME = 'device_api_id'
);
SET @sql = IF(@col_exists = 0,
  'ALTER TABLE `proxies` ADD COLUMN `device_api_id` INT NULL AFTER `device_id`',
  'SELECT ''Column device_api_id already exists'' AS message'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Device model (from device.model)
SET @col_exists = (
  SELECT COUNT(*) 
  FROM INFORMATION_SCHEMA.COLUMNS 
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'proxies' 
    AND COLUMN_NAME = 'model'
);
SET @sql = IF(@col_exists = 0,
  'ALTER TABLE `proxies` ADD COLUMN `model` VARCHAR(100) NULL AFTER `name`',
  'SELECT ''Column model already exists'' AS message'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Device IP address (from device.ip_address)
SET @col_exists = (
  SELECT COUNT(*) 
  FROM INFORMATION_SCHEMA.COLUMNS 
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'proxies' 
    AND COLUMN_NAME = 'ip_address'
);
SET @sql = IF(@col_exists = 0,
  'ALTER TABLE `proxies` ADD COLUMN `ip_address` VARCHAR(45) NULL AFTER `active`',
  'SELECT ''Column ip_address already exists'' AS message'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- WebSocket status (from device.ws_status)
SET @col_exists = (
  SELECT COUNT(*) 
  FROM INFORMATION_SCHEMA.COLUMNS 
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'proxies' 
    AND COLUMN_NAME = 'ws_status'
);
SET @sql = IF(@col_exists = 0,
  'ALTER TABLE `proxies` ADD COLUMN `ws_status` VARCHAR(50) NULL AFTER `ip_address`',
  'SELECT ''Column ws_status already exists'' AS message'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Proxy status (from device.proxy_status)
SET @col_exists = (
  SELECT COUNT(*) 
  FROM INFORMATION_SCHEMA.COLUMNS 
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'proxies' 
    AND COLUMN_NAME = 'proxy_status'
);
SET @sql = IF(@col_exists = 0,
  'ALTER TABLE `proxies` ADD COLUMN `proxy_status` VARCHAR(50) NULL AFTER `ws_status`',
  'SELECT ''Column proxy_status already exists'' AS message'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Country (from device.country)
SET @col_exists = (
  SELECT COUNT(*) 
  FROM INFORMATION_SCHEMA.COLUMNS 
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'proxies' 
    AND COLUMN_NAME = 'country'
);
SET @sql = IF(@col_exists = 0,
  'ALTER TABLE `proxies` ADD COLUMN `country` VARCHAR(100) NULL AFTER `proxy_status`',
  'SELECT ''Column country already exists'' AS message'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- State (from device.state)
SET @col_exists = (
  SELECT COUNT(*) 
  FROM INFORMATION_SCHEMA.COLUMNS 
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'proxies' 
    AND COLUMN_NAME = 'state'
);
SET @sql = IF(@col_exists = 0,
  'ALTER TABLE `proxies` ADD COLUMN `state` VARCHAR(100) NULL AFTER `country`',
  'SELECT ''Column state already exists'' AS message'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- City (from device.city)
SET @col_exists = (
  SELECT COUNT(*) 
  FROM INFORMATION_SCHEMA.COLUMNS 
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'proxies' 
    AND COLUMN_NAME = 'city'
);
SET @sql = IF(@col_exists = 0,
  'ALTER TABLE `proxies` ADD COLUMN `city` VARCHAR(100) NULL AFTER `state`',
  'SELECT ''Column city already exists'' AS message'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Street (from device.street)
SET @col_exists = (
  SELECT COUNT(*) 
  FROM INFORMATION_SCHEMA.COLUMNS 
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'proxies' 
    AND COLUMN_NAME = 'street'
);
SET @sql = IF(@col_exists = 0,
  'ALTER TABLE `proxies` ADD COLUMN `street` VARCHAR(255) NULL AFTER `city`',
  'SELECT ''Column street already exists'' AS message'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Longitude (from device.longitude)
SET @col_exists = (
  SELECT COUNT(*) 
  FROM INFORMATION_SCHEMA.COLUMNS 
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'proxies' 
    AND COLUMN_NAME = 'longitude'
);
SET @sql = IF(@col_exists = 0,
  'ALTER TABLE `proxies` ADD COLUMN `longitude` DOUBLE NULL AFTER `street`',
  'SELECT ''Column longitude already exists'' AS message'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Latitude (from device.latitude)
SET @col_exists = (
  SELECT COUNT(*) 
  FROM INFORMATION_SCHEMA.COLUMNS 
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'proxies' 
    AND COLUMN_NAME = 'latitude'
);
SET @sql = IF(@col_exists = 0,
  'ALTER TABLE `proxies` ADD COLUMN `latitude` DOUBLE NULL AFTER `longitude`',
  'SELECT ''Column latitude already exists'' AS message'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Relay server ID (from device.relay_server_id)
SET @col_exists = (
  SELECT COUNT(*) 
  FROM INFORMATION_SCHEMA.COLUMNS 
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'proxies' 
    AND COLUMN_NAME = 'relay_server_id'
);
SET @sql = IF(@col_exists = 0,
  'ALTER TABLE `proxies` ADD COLUMN `relay_server_id` INT NULL AFTER `latitude`',
  'SELECT ''Column relay_server_id already exists'' AS message'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Relay server IP address (from device.relay_server_ip_address)
SET @col_exists = (
  SELECT COUNT(*) 
  FROM INFORMATION_SCHEMA.COLUMNS 
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'proxies' 
    AND COLUMN_NAME = 'relay_server_ip_address'
);
SET @sql = IF(@col_exists = 0,
  'ALTER TABLE `proxies` ADD COLUMN `relay_server_ip_address` VARCHAR(45) NULL AFTER `relay_server_id`',
  'SELECT ''Column relay_server_ip_address already exists'' AS message'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Download net speed (from device.download_net_speed)
SET @col_exists = (
  SELECT COUNT(*) 
  FROM INFORMATION_SCHEMA.COLUMNS 
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'proxies' 
    AND COLUMN_NAME = 'download_net_speed'
);
SET @sql = IF(@col_exists = 0,
  'ALTER TABLE `proxies` ADD COLUMN `download_net_speed` DOUBLE NULL AFTER `relay_server_ip_address`',
  'SELECT ''Column download_net_speed already exists'' AS message'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Upload net speed (from device.upload_net_speed)
SET @col_exists = (
  SELECT COUNT(*) 
  FROM INFORMATION_SCHEMA.COLUMNS 
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'proxies' 
    AND COLUMN_NAME = 'upload_net_speed'
);
SET @sql = IF(@col_exists = 0,
  'ALTER TABLE `proxies` ADD COLUMN `upload_net_speed` DOUBLE NULL AFTER `download_net_speed`',
  'SELECT ''Column upload_net_speed already exists'' AS message'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Last IP rotation (from device.last_ip_rotation)
SET @col_exists = (
  SELECT COUNT(*) 
  FROM INFORMATION_SCHEMA.COLUMNS 
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'proxies' 
    AND COLUMN_NAME = 'last_ip_rotation'
);
SET @sql = IF(@col_exists = 0,
  'ALTER TABLE `proxies` ADD COLUMN `last_ip_rotation` VARCHAR(50) NULL AFTER `upload_net_speed`',
  'SELECT ''Column last_ip_rotation already exists'' AS message'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Add indexes (check if they exist first)
SET @idx_exists = (
  SELECT COUNT(*) 
  FROM INFORMATION_SCHEMA.STATISTICS 
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'proxies'
    AND INDEX_NAME = 'idx_proxies_proxy_status'
);
SET @sql = IF(@idx_exists = 0,
  'CREATE INDEX `idx_proxies_proxy_status` ON `proxies` (`proxy_status`)',
  'SELECT ''Index idx_proxies_proxy_status already exists'' AS message'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @idx_exists = (
  SELECT COUNT(*) 
  FROM INFORMATION_SCHEMA.STATISTICS 
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'proxies'
    AND INDEX_NAME = 'idx_proxies_country'
);
SET @sql = IF(@idx_exists = 0,
  'CREATE INDEX `idx_proxies_country` ON `proxies` (`country`)',
  'SELECT ''Index idx_proxies_country already exists'' AS message'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @idx_exists = (
  SELECT COUNT(*) 
  FROM INFORMATION_SCHEMA.STATISTICS 
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'proxies'
    AND INDEX_NAME = 'idx_proxies_state'
);
SET @sql = IF(@idx_exists = 0,
  'CREATE INDEX `idx_proxies_state` ON `proxies` (`state`)',
  'SELECT ''Index idx_proxies_state already exists'' AS message'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @idx_exists = (
  SELECT COUNT(*) 
  FROM INFORMATION_SCHEMA.STATISTICS 
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'proxies'
    AND INDEX_NAME = 'idx_proxies_city'
);
SET @sql = IF(@idx_exists = 0,
  'CREATE INDEX `idx_proxies_city` ON `proxies` (`city`)',
  'SELECT ''Index idx_proxies_city already exists'' AS message'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
