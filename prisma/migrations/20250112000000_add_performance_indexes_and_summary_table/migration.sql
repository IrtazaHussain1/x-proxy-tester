-- Migration: Add Performance Indexes and Hourly Summary Table
-- This migration adds composite indexes for common query patterns and creates
-- a pre-aggregated hourly summary table to improve Grafana query performance

-- ============================================
-- Step 1: Add Composite Indexes for Query Optimization
-- ============================================

-- Index for queries filtering by timestamp and status (common in Grafana)
-- Note: IF NOT EXISTS not supported in MySQL < 8.0, errors are handled in application code
CREATE INDEX idx_proxy_requests_timestamp_status 
ON proxy_requests(timestamp, status);

-- Index for queries filtering by timestamp and source
CREATE INDEX idx_proxy_requests_timestamp_source 
ON proxy_requests(timestamp, source);

-- Index for queries filtering by timestamp and proxy_id (optimizes JOINs)
CREATE INDEX idx_proxy_requests_timestamp_proxy_id 
ON proxy_requests(timestamp, proxy_id);

-- Composite index for location-based queries (via JOIN with proxies)
CREATE INDEX idx_proxies_location_active_device_id 
ON proxies(location, active, device_id);

-- Index for timestamp-based queries with response_time filtering
CREATE INDEX idx_proxy_requests_timestamp_response_time 
ON proxy_requests(timestamp, response_time_ms);

-- ============================================
-- Step 2: Create Hourly Summary Table
-- ============================================

CREATE TABLE proxy_requests_hourly_summary (
  hour DATETIME NOT NULL,
  proxy_id VARCHAR(255) NOT NULL,
  location VARCHAR(255),
  total_requests INT DEFAULT 0,
  success_count INT DEFAULT 0,
  failure_count INT DEFAULT 0,
  avg_response_time_ms DECIMAL(10,2),
  min_response_time_ms INT,
  max_response_time_ms INT,
  timeout_count INT DEFAULT 0,
  connection_error_count INT DEFAULT 0,
  http_error_count INT DEFAULT 0,
  dns_error_count INT DEFAULT 0,
  rotation_count INT DEFAULT 0,
  avg_download_speed_mbps DECIMAL(10,2),
  avg_upload_speed_mbps DECIMAL(10,2),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (hour, proxy_id),
  INDEX idx_hour_location (hour, location),
  INDEX idx_hour (hour),
  INDEX idx_proxy_id (proxy_id),
  FOREIGN KEY (proxy_id) REFERENCES proxies(device_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- Step 3: Create Stored Procedure for Populating Summary Table
-- ============================================

DELIMITER //

CREATE PROCEDURE populate_hourly_summary(IN summary_hour DATETIME)
BEGIN
  INSERT INTO proxy_requests_hourly_summary (
    hour,
    proxy_id,
    location,
    total_requests,
    success_count,
    failure_count,
    avg_response_time_ms,
    min_response_time_ms,
    max_response_time_ms,
    timeout_count,
    connection_error_count,
    http_error_count,
    dns_error_count,
    rotation_count,
    avg_download_speed_mbps,
    avg_upload_speed_mbps
  )
  SELECT 
    DATE_FORMAT(pr.timestamp, '%Y-%m-%d %H:00:00') as hour,
    pr.proxy_id,
    p.location,
    COUNT(*) as total_requests,
    COUNT(CASE WHEN pr.status = 'SUCCESS' THEN 1 END) as success_count,
    COUNT(CASE WHEN pr.status != 'SUCCESS' THEN 1 END) as failure_count,
    AVG(pr.response_time_ms) as avg_response_time_ms,
    MIN(pr.response_time_ms) as min_response_time_ms,
    MAX(pr.response_time_ms) as max_response_time_ms,
    COUNT(CASE WHEN pr.status = 'TIMEOUT' THEN 1 END) as timeout_count,
    COUNT(CASE WHEN pr.status = 'CONNECTION_ERROR' THEN 1 END) as connection_error_count,
    COUNT(CASE WHEN pr.status = 'HTTP_ERROR' THEN 1 END) as http_error_count,
    COUNT(CASE WHEN pr.status = 'DNS_ERROR' THEN 1 END) as dns_error_count,
    COUNT(CASE WHEN pr.ip_changed = true THEN 1 END) as rotation_count,
    AVG(pr.download_speed_mbps) as avg_download_speed_mbps,
    AVG(pr.upload_speed_mbps) as avg_upload_speed_mbps
  FROM proxy_requests pr
  LEFT JOIN proxies p ON pr.proxy_id = p.device_id
  WHERE DATE_FORMAT(pr.timestamp, '%Y-%m-%d %H:00:00') = DATE_FORMAT(summary_hour, '%Y-%m-%d %H:00:00')
    AND pr.timestamp IS NOT NULL
  GROUP BY hour, pr.proxy_id, p.location
  ON DUPLICATE KEY UPDATE
    total_requests = VALUES(total_requests),
    success_count = VALUES(success_count),
    failure_count = VALUES(failure_count),
    avg_response_time_ms = VALUES(avg_response_time_ms),
    min_response_time_ms = VALUES(min_response_time_ms),
    max_response_time_ms = VALUES(max_response_time_ms),
    timeout_count = VALUES(timeout_count),
    connection_error_count = VALUES(connection_error_count),
    http_error_count = VALUES(http_error_count),
    dns_error_count = VALUES(dns_error_count),
    rotation_count = VALUES(rotation_count),
    avg_download_speed_mbps = VALUES(avg_download_speed_mbps),
    avg_upload_speed_mbps = VALUES(avg_upload_speed_mbps),
    updated_at = CURRENT_TIMESTAMP;
END //

DELIMITER ;

