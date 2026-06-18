-- Migration: Add proxy_requests_5min_summary table
-- Purpose: Pre-aggregate proxy_requests into 5-minute windows so Grafana live dashboards,
--          the stability calculator, and the analytics API can read ~576 rows/proxy/day
--          instead of scanning the raw 2-4M rows/day proxy_requests table.
-- Retention: 2 days (rolling DELETE in app-side purge job).
-- No partitioning needed: max ~115K rows at 200 proxies.

SET @db = DATABASE();

SET @sql = IF(
  (SELECT COUNT(*) FROM information_schema.TABLES
   WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'proxy_requests_5min_summary') = 0,
  'CREATE TABLE proxy_requests_5min_summary (
    window_start            DATETIME     NOT NULL
                            COMMENT ''Floor of 5-min bucket: FLOOR(UNIX_TIMESTAMP(ts)/300)*300'',
    proxy_id                VARCHAR(255) NOT NULL,

    -- Additive counters (safe to SUM across windows)
    total_requests          INT          NOT NULL DEFAULT 0,
    success_count           INT          NOT NULL DEFAULT 0,
    failure_count           INT          NOT NULL DEFAULT 0,
    timeout_count           INT          NOT NULL DEFAULT 0,
    connection_error_count  INT          NOT NULL DEFAULT 0,
    http_error_count        INT          NOT NULL DEFAULT 0,
    dns_error_count         INT          NOT NULL DEFAULT 0,
    ip_change_count         INT          NOT NULL DEFAULT 0,
    slow_request_count      INT          NOT NULL DEFAULT 0
                            COMMENT ''Requests with response_time_ms > 2000'',

    -- Pre-computed ratios (used directly by Grafana stat panels)
    success_rate_pct        DECIMAL(5,2)  NULL,

    -- Response-time aggregates (AVG weighted by total_requests; MIN/MAX exact)
    avg_response_time_ms    DECIMAL(10,2) NULL,
    min_response_time_ms    INT           NULL,
    max_response_time_ms    INT           NULL,

    -- Last known outbound IP in this window (for live IP display panels)
    last_outbound_ip        VARCHAR(45)   NULL,

    created_at              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
                                     ON UPDATE CURRENT_TIMESTAMP,

    PRIMARY KEY (window_start, proxy_id),
    INDEX idx_5min_proxy_window (proxy_id, window_start),
    INDEX idx_5min_window_start (window_start)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci',
  'SELECT 1 -- proxy_requests_5min_summary already exists'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
