-- ============================================
-- Additional Indexes for Grafana Query Performance
-- ============================================
-- Run these to optimize queries for large datasets
-- These indexes will significantly improve Grafana dashboard load times

-- Composite index for timestamp-based queries (most common in Grafana)
-- This index covers the most frequent query pattern: filtering by timestamp
CREATE INDEX IF NOT EXISTS idx_proxy_requests_timestamp_status 
ON proxy_requests(timestamp DESC, status, proxy_id);

-- Index for IP rotation queries (MySQL doesn't support partial indexes, so we index the column)
-- For queries filtering by ip_changed = true, MySQL will use this index
CREATE INDEX IF NOT EXISTS idx_proxy_requests_ip_changed_timestamp 
ON proxy_requests(ip_changed, timestamp DESC);

-- Index for proxy_id + timestamp (for per-proxy time series)
-- This is critical for fetching large datasets per proxy
CREATE INDEX IF NOT EXISTS idx_proxy_requests_proxy_timestamp 
ON proxy_requests(proxy_id, timestamp DESC);

-- Index for error analysis queries
-- MySQL will use this index even when filtering error_type IS NOT NULL
CREATE INDEX IF NOT EXISTS idx_proxy_requests_error_type_timestamp 
ON proxy_requests(error_type, timestamp DESC);

-- Index for source-based queries (continuous vs periodic_rotation)
CREATE INDEX IF NOT EXISTS idx_proxy_requests_source_timestamp 
ON proxy_requests(source, timestamp DESC);

-- Composite index for active proxy queries
-- This index helps with filtering active proxies quickly
CREATE INDEX IF NOT EXISTS idx_proxies_active_stability 
ON proxies(active, stability_status, rotation_status);

-- Additional composite index for timestamp + status + proxy_id (most common Grafana query pattern)
-- This covers WHERE timestamp >= X AND status = Y AND proxy_id = Z
CREATE INDEX IF NOT EXISTS idx_proxy_requests_timestamp_status_proxy 
ON proxy_requests(timestamp DESC, status, proxy_id);

-- Index for response_time_ms queries (for performance dashboards)
-- Note: MySQL doesn't support partial indexes, so we index the column normally
-- MySQL will still use this index efficiently when filtering response_time_ms IS NOT NULL
CREATE INDEX IF NOT EXISTS idx_proxy_requests_timestamp_response_time 
ON proxy_requests(timestamp DESC, response_time_ms);

-- ============================================
-- Query Optimization Tips for Grafana
-- ============================================
-- When creating custom queries in Grafana dashboards:

-- 1. Always filter by timestamp first (uses index)
--    WHERE timestamp >= $__timeFrom() AND timestamp <= $__timeTo()

-- 2. Use LIMIT for large result sets
--    LIMIT 1000

-- 3. Aggregate data when possible (use views instead of raw tables)
--    Use v_hourly_aggregates instead of proxy_requests for time series

-- 4. Avoid SELECT * - only select needed columns

-- 5. Use indexed columns in WHERE clauses
--    proxy_id, timestamp, status are all indexed

-- ============================================
-- Example Optimized Queries for Grafana
-- ============================================

-- Example 1: Time series with proper indexing
-- SELECT 
--   timestamp as time,
--   AVG(response_time_ms) as value
-- FROM proxy_requests
-- WHERE timestamp >= $__timeFrom() 
--   AND timestamp <= $__timeTo()
--   AND proxy_id = '$proxy_id'
-- GROUP BY timestamp
-- ORDER BY timestamp ASC
-- LIMIT 1000;

-- Example 2: Use aggregated view for better performance
-- SELECT 
--   hour as time,
--   avg_response_time as value
-- FROM v_hourly_aggregates
-- WHERE hour >= DATE_FORMAT($__timeFrom(), '%Y-%m-%d %H:00:00')
--   AND hour <= DATE_FORMAT($__timeTo(), '%Y-%m-%d %H:00:00')
-- ORDER BY hour ASC;

-- Example 3: Error analysis with index
-- SELECT 
--   error_type,
--   COUNT(*) as count
-- FROM proxy_requests
-- WHERE timestamp >= $__timeFrom() 
--   AND timestamp <= $__timeTo()
--   AND error_type IS NOT NULL
-- GROUP BY error_type
-- ORDER BY count DESC
-- LIMIT 20;

