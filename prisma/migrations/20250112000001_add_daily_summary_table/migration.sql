-- Migration: Add Daily Summary Table for Long-Term Data Aggregation
-- This migration creates a daily summary table to store aggregated data
-- Raw data older than 2 weeks will be deleted, keeping only daily aggregates

-- ============================================
-- Step 1: Create Daily Summary Table
-- ============================================

CREATE TABLE proxy_requests_daily_summary (
  day DATE NOT NULL,
  proxy_id VARCHAR(255) NOT NULL,
  location VARCHAR(255),
  total_requests INT DEFAULT 0,
  success_count INT DEFAULT 0,
  failure_count INT DEFAULT 0,
  avg_response_time_ms DECIMAL(10,2),
  min_response_time_ms INT,
  max_response_time_ms INT,
  p50_response_time_ms INT,
  p95_response_time_ms INT,
  p99_response_time_ms INT,
  timeout_count INT DEFAULT 0,
  connection_error_count INT DEFAULT 0,
  http_error_count INT DEFAULT 0,
  dns_error_count INT DEFAULT 0,
  rotation_count INT DEFAULT 0,
  avg_download_speed_mbps DECIMAL(10,2),
  avg_upload_speed_mbps DECIMAL(10,2),
  max_download_speed_mbps DECIMAL(10,2),
  max_upload_speed_mbps DECIMAL(10,2),
  min_download_speed_mbps DECIMAL(10,2),
  min_upload_speed_mbps DECIMAL(10,2),
  unique_ips_count INT DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (day, proxy_id),
  INDEX idx_day_location (day, location),
  INDEX idx_day (day),
  INDEX idx_proxy_id (proxy_id),
  FOREIGN KEY (proxy_id) REFERENCES proxies(device_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- Step 2: Create Stored Procedure for Daily Aggregation
-- ============================================

DELIMITER //

CREATE PROCEDURE aggregate_daily_summary(IN summary_day DATE)
BEGIN
  INSERT INTO proxy_requests_daily_summary (
    day,
    proxy_id,
    location,
    total_requests,
    success_count,
    failure_count,
    avg_response_time_ms,
    min_response_time_ms,
    max_response_time_ms,
    p50_response_time_ms,
    p95_response_time_ms,
    p99_response_time_ms,
    timeout_count,
    connection_error_count,
    http_error_count,
    dns_error_count,
    rotation_count,
    avg_download_speed_mbps,
    avg_upload_speed_mbps,
    max_download_speed_mbps,
    max_upload_speed_mbps,
    min_download_speed_mbps,
    min_upload_speed_mbps,
    unique_ips_count
  )
  SELECT 
    DATE(pr.timestamp) as day,
    pr.proxy_id,
    p.location,
    COUNT(*) as total_requests,
    COUNT(CASE WHEN pr.status = 'SUCCESS' THEN 1 END) as success_count,
    COUNT(CASE WHEN pr.status != 'SUCCESS' THEN 1 END) as failure_count,
    AVG(pr.response_time_ms) as avg_response_time_ms,
    MIN(pr.response_time_ms) as min_response_time_ms,
    MAX(pr.response_time_ms) as max_response_time_ms,
    -- Percentiles using window functions (MySQL 8.0+)
    (SELECT response_time_ms FROM (
      SELECT response_time_ms, 
             ROW_NUMBER() OVER (ORDER BY response_time_ms) as rn,
             COUNT(*) OVER () as total
      FROM proxy_requests pr2
      WHERE DATE(pr2.timestamp) = summary_day 
        AND pr2.proxy_id = pr.proxy_id
        AND pr2.response_time_ms IS NOT NULL
    ) ranked WHERE rn = FLOOR(total * 0.50) + 1 LIMIT 1) as p50_response_time_ms,
    (SELECT response_time_ms FROM (
      SELECT response_time_ms, 
             ROW_NUMBER() OVER (ORDER BY response_time_ms) as rn,
             COUNT(*) OVER () as total
      FROM proxy_requests pr2
      WHERE DATE(pr2.timestamp) = summary_day 
        AND pr2.proxy_id = pr.proxy_id
        AND pr2.response_time_ms IS NOT NULL
    ) ranked WHERE rn = FLOOR(total * 0.95) + 1 LIMIT 1) as p95_response_time_ms,
    (SELECT response_time_ms FROM (
      SELECT response_time_ms, 
             ROW_NUMBER() OVER (ORDER BY response_time_ms) as rn,
             COUNT(*) OVER () as total
      FROM proxy_requests pr2
      WHERE DATE(pr2.timestamp) = summary_day 
        AND pr2.proxy_id = pr.proxy_id
        AND pr2.response_time_ms IS NOT NULL
    ) ranked WHERE rn = FLOOR(total * 0.99) + 1 LIMIT 1) as p99_response_time_ms,
    COUNT(CASE WHEN pr.status = 'TIMEOUT' THEN 1 END) as timeout_count,
    COUNT(CASE WHEN pr.status = 'CONNECTION_ERROR' THEN 1 END) as connection_error_count,
    COUNT(CASE WHEN pr.status = 'HTTP_ERROR' THEN 1 END) as http_error_count,
    COUNT(CASE WHEN pr.status = 'DNS_ERROR' THEN 1 END) as dns_error_count,
    COUNT(CASE WHEN pr.ip_changed = true THEN 1 END) as rotation_count,
    AVG(pr.download_speed_mbps) as avg_download_speed_mbps,
    AVG(pr.upload_speed_mbps) as avg_upload_speed_mbps,
    MAX(pr.download_speed_mbps) as max_download_speed_mbps,
    MAX(pr.upload_speed_mbps) as max_upload_speed_mbps,
    MIN(pr.download_speed_mbps) as min_download_speed_mbps,
    MIN(pr.upload_speed_mbps) as min_upload_speed_mbps,
    COUNT(DISTINCT pr.outbound_ip) as unique_ips_count
  FROM proxy_requests pr
  LEFT JOIN proxies p ON pr.proxy_id = p.device_id
  WHERE DATE(pr.timestamp) = summary_day
    AND pr.timestamp IS NOT NULL
  GROUP BY day, pr.proxy_id, p.location
  ON DUPLICATE KEY UPDATE
    total_requests = VALUES(total_requests),
    success_count = VALUES(success_count),
    failure_count = VALUES(failure_count),
    avg_response_time_ms = VALUES(avg_response_time_ms),
    min_response_time_ms = VALUES(min_response_time_ms),
    max_response_time_ms = VALUES(max_response_time_ms),
    p50_response_time_ms = VALUES(p50_response_time_ms),
    p95_response_time_ms = VALUES(p95_response_time_ms),
    p99_response_time_ms = VALUES(p99_response_time_ms),
    timeout_count = VALUES(timeout_count),
    connection_error_count = VALUES(connection_error_count),
    http_error_count = VALUES(http_error_count),
    dns_error_count = VALUES(dns_error_count),
    rotation_count = VALUES(rotation_count),
    avg_download_speed_mbps = VALUES(avg_download_speed_mbps),
    avg_upload_speed_mbps = VALUES(avg_upload_speed_mbps),
    max_download_speed_mbps = VALUES(max_download_speed_mbps),
    max_upload_speed_mbps = VALUES(max_upload_speed_mbps),
    min_download_speed_mbps = VALUES(min_download_speed_mbps),
    min_upload_speed_mbps = VALUES(min_upload_speed_mbps),
    unique_ips_count = VALUES(unique_ips_count),
    updated_at = CURRENT_TIMESTAMP;
END //

DELIMITER ;

