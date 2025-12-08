-- SQL Views for Grafana Dashboards
-- These views pre-aggregate data to improve query performance
-- Run these after setting up your database

-- ============================================
-- View 1: Proxy Summary (Current Status)
-- ============================================
-- Provides current status of all proxies with latest metrics
CREATE OR REPLACE VIEW v_proxy_summary AS
SELECT 
  p.device_id,
  p.name,
  p.location,
  p.host,
  p.port,
  p.active,
  p.stability_status,
  p.rotation_status,
  p.last_ip,
  p.same_ip_count,
  p.rotation_count,
  p.last_rotation_at,
  p.created_at,
  p.updated_at,
  -- Last 24h metrics
  COUNT(pr.id) as total_requests_24h,
  COUNT(CASE WHEN pr.status = 'SUCCESS' THEN 1 END) as success_count_24h,
  COUNT(CASE WHEN pr.status != 'SUCCESS' THEN 1 END) as failure_count_24h,
  COUNT(CASE WHEN pr.status = 'SUCCESS' THEN 1 END) * 100.0 / NULLIF(COUNT(pr.id), 0) as success_rate_24h,
  AVG(pr.response_time_ms) as avg_response_time_24h,
  MIN(pr.response_time_ms) as min_response_time_24h,
  MAX(pr.response_time_ms) as max_response_time_24h,
  COUNT(CASE WHEN pr.ip_changed = true THEN 1 END) as rotation_count_24h,
  -- Last hour metrics
  COUNT(CASE WHEN pr.timestamp >= DATE_SUB(NOW(), INTERVAL 1 HOUR) THEN 1 END) as total_requests_1h,
  COUNT(CASE WHEN pr.timestamp >= DATE_SUB(NOW(), INTERVAL 1 HOUR) AND pr.status = 'SUCCESS' THEN 1 END) as success_count_1h,
  COUNT(CASE WHEN pr.timestamp >= DATE_SUB(NOW(), INTERVAL 1 HOUR) AND pr.status = 'SUCCESS' THEN 1 END) * 100.0 / NULLIF(COUNT(CASE WHEN pr.timestamp >= DATE_SUB(NOW(), INTERVAL 1 HOUR) THEN 1 END), 0) as success_rate_1h
FROM proxies p
LEFT JOIN proxy_requests pr ON p.device_id = pr.proxy_id
  AND pr.timestamp >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
WHERE p.active = true
GROUP BY 
  p.device_id, p.name, p.location, p.host, p.port, p.active,
  p.stability_status, p.rotation_status, p.last_ip, p.same_ip_count,
  p.rotation_count, p.last_rotation_at, p.created_at, p.updated_at;

-- ============================================
-- View 2: Hourly Aggregates
-- ============================================
-- Aggregates request data by hour for time series queries
CREATE OR REPLACE VIEW v_hourly_aggregates AS
SELECT 
  DATE_FORMAT(timestamp, '%Y-%m-%d %H:00:00') as hour,
  proxy_id,
  COUNT(*) as total_requests,
  COUNT(CASE WHEN status = 'SUCCESS' THEN 1 END) as success_count,
  COUNT(CASE WHEN status != 'SUCCESS' THEN 1 END) as failure_count,
  COUNT(CASE WHEN status = 'SUCCESS' THEN 1 END) * 100.0 / COUNT(*) as success_rate,
  AVG(response_time_ms) as avg_response_time,
  MIN(response_time_ms) as min_response_time,
  MAX(response_time_ms) as max_response_time,
  COUNT(CASE WHEN ip_changed = true THEN 1 END) as rotation_count,
  COUNT(CASE WHEN status = 'TIMEOUT' THEN 1 END) as timeout_count,
  COUNT(CASE WHEN status = 'CONNECTION_ERROR' THEN 1 END) as connection_error_count,
  COUNT(CASE WHEN status = 'HTTP_ERROR' THEN 1 END) as http_error_count,
  COUNT(CASE WHEN status = 'DNS_ERROR' THEN 1 END) as dns_error_count
FROM proxy_requests
WHERE timestamp >= DATE_SUB(NOW(), INTERVAL 30 DAY)
GROUP BY hour, proxy_id;

-- ============================================
-- View 3: System-Wide Hourly Stats
-- ============================================
-- System-wide aggregates by hour (no proxy breakdown)
CREATE OR REPLACE VIEW v_system_hourly_stats AS
SELECT 
  DATE_FORMAT(timestamp, '%Y-%m-%d %H:00:00') as hour,
  COUNT(*) as total_requests,
  COUNT(DISTINCT proxy_id) as active_proxies,
  COUNT(CASE WHEN status = 'SUCCESS' THEN 1 END) as success_count,
  COUNT(CASE WHEN status != 'SUCCESS' THEN 1 END) as failure_count,
  COUNT(CASE WHEN status = 'SUCCESS' THEN 1 END) * 100.0 / COUNT(*) as success_rate,
  AVG(response_time_ms) as avg_response_time,
  MIN(response_time_ms) as min_response_time,
  MAX(response_time_ms) as max_response_time,
  COUNT(CASE WHEN ip_changed = true THEN 1 END) as total_rotations,
  COUNT(CASE WHEN status = 'TIMEOUT' THEN 1 END) as timeout_count,
  COUNT(CASE WHEN status = 'CONNECTION_ERROR' THEN 1 END) as connection_error_count,
  COUNT(CASE WHEN status = 'HTTP_ERROR' THEN 1 END) as http_error_count,
  COUNT(CASE WHEN status = 'DNS_ERROR' THEN 1 END) as dns_error_count
FROM proxy_requests
WHERE timestamp >= DATE_SUB(NOW(), INTERVAL 30 DAY)
GROUP BY hour;

-- ============================================
-- View 4: Stability Status Summary
-- ============================================
-- Current stability status breakdown
CREATE OR REPLACE VIEW v_stability_summary AS
SELECT 
  stability_status,
  COUNT(*) as proxy_count,
  COUNT(*) * 100.0 / (SELECT COUNT(*) FROM proxies WHERE active = true) as percentage
FROM proxies
WHERE active = true
GROUP BY stability_status;

-- ============================================
-- View 5: Rotation Status Summary
-- ============================================
-- Current rotation status breakdown
CREATE OR REPLACE VIEW v_rotation_summary AS
SELECT 
  rotation_status,
  COUNT(*) as proxy_count,
  AVG(rotation_count) as avg_rotation_count,
  AVG(same_ip_count) as avg_same_ip_count,
  MAX(same_ip_count) as max_same_ip_count
FROM proxies
WHERE active = true
GROUP BY rotation_status;

-- ============================================
-- View 6: Error Type Summary (Last 24h)
-- ============================================
-- Error breakdown by type
CREATE OR REPLACE VIEW v_error_summary_24h AS
SELECT 
  error_type,
  COUNT(*) as error_count,
  COUNT(*) * 100.0 / (SELECT COUNT(*) FROM proxy_requests WHERE status != 'SUCCESS' AND timestamp >= DATE_SUB(NOW(), INTERVAL 24 HOUR)) as percentage
FROM proxy_requests
WHERE status != 'SUCCESS'
  AND timestamp >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
  AND error_type IS NOT NULL
GROUP BY error_type
ORDER BY error_count DESC;

-- ============================================
-- View 7: Location-Based Stats
-- ============================================
-- Statistics grouped by location
CREATE OR REPLACE VIEW v_location_stats AS
SELECT 
  p.location,
  COUNT(DISTINCT p.device_id) as proxy_count,
  COUNT(CASE WHEN p.stability_status = 'Stable' THEN 1 END) as stable_count,
  COUNT(CASE WHEN p.stability_status = 'UnstableHourly' THEN 1 END) as unstable_hourly_count,
  COUNT(CASE WHEN p.stability_status = 'UnstableDaily' THEN 1 END) as unstable_daily_count,
  AVG(pr.response_time_ms) as avg_response_time,
  COUNT(CASE WHEN pr.status = 'SUCCESS' THEN 1 END) * 100.0 / NULLIF(COUNT(pr.id), 0) as success_rate,
  AVG(p.rotation_count) as avg_rotation_count
FROM proxies p
LEFT JOIN proxy_requests pr ON p.device_id = pr.proxy_id
  AND pr.timestamp >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
WHERE p.active = true
GROUP BY p.location;

-- ============================================
-- View 8: Top Performers (Last 24h)
-- ============================================
-- Top proxies by success rate and performance
CREATE OR REPLACE VIEW v_top_performers_24h AS
SELECT 
  p.device_id,
  p.name,
  p.location,
  COUNT(pr.id) as total_requests,
  COUNT(CASE WHEN pr.status = 'SUCCESS' THEN 1 END) * 100.0 / NULLIF(COUNT(pr.id), 0) as success_rate,
  AVG(pr.response_time_ms) as avg_response_time,
  p.stability_status,
  p.rotation_status
FROM proxies p
JOIN proxy_requests pr ON p.device_id = pr.proxy_id
WHERE pr.timestamp >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
  AND p.active = true
GROUP BY p.device_id, p.name, p.location, p.stability_status, p.rotation_status
HAVING total_requests >= 100  -- Minimum requests for meaningful stats
ORDER BY success_rate DESC, avg_response_time ASC
LIMIT 50;

-- ============================================
-- View 9: Worst Performers (Last 24h)
-- ============================================
-- Proxies with highest error rates
CREATE OR REPLACE VIEW v_worst_performers_24h AS
SELECT 
  p.device_id,
  p.name,
  p.location,
  COUNT(pr.id) as total_requests,
  COUNT(CASE WHEN pr.status = 'SUCCESS' THEN 1 END) * 100.0 / NULLIF(COUNT(pr.id), 0) as success_rate,
  AVG(pr.response_time_ms) as avg_response_time,
  COUNT(CASE WHEN pr.status != 'SUCCESS' THEN 1 END) as failure_count,
  p.stability_status,
  p.rotation_status
FROM proxies p
JOIN proxy_requests pr ON p.device_id = pr.proxy_id
WHERE pr.timestamp >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
  AND p.active = true
GROUP BY p.device_id, p.name, p.location, p.stability_status, p.rotation_status
HAVING total_requests >= 100  -- Minimum requests for meaningful stats
ORDER BY success_rate ASC, failure_count DESC
LIMIT 50;

-- ============================================
-- View 10: Recent Rotations
-- ============================================
-- Recent IP rotation events
CREATE OR REPLACE VIEW v_recent_rotations AS
SELECT 
  pr.timestamp,
  pr.proxy_id,
  p.name,
  p.location,
  pr.outbound_ip as new_ip,
  LAG(pr.outbound_ip) OVER (PARTITION BY pr.proxy_id ORDER BY pr.timestamp) as previous_ip,
  pr.response_time_ms
FROM proxy_requests pr
JOIN proxies p ON pr.proxy_id = p.device_id
WHERE pr.ip_changed = true
  AND pr.timestamp >= DATE_SUB(NOW(), INTERVAL 7 DAY)
ORDER BY pr.timestamp DESC;

-- ============================================
-- View 11: Proxy Health Score
-- ============================================
-- Calculated health score for each proxy
CREATE OR REPLACE VIEW v_proxy_health_score AS
SELECT 
  p.device_id,
  p.name,
  p.location,
  p.stability_status,
  p.rotation_status,
  -- Success rate component (0-50 points)
  COALESCE(
    COUNT(CASE WHEN pr.status = 'SUCCESS' THEN 1 END) * 50.0 / NULLIF(COUNT(pr.id), 0),
    0
  ) as success_rate_score,
  -- Response time component (0-30 points, inverse)
  CASE 
    WHEN AVG(pr.response_time_ms) IS NULL THEN 0
    WHEN AVG(pr.response_time_ms) < 1000 THEN 30
    WHEN AVG(pr.response_time_ms) < 2000 THEN 25
    WHEN AVG(pr.response_time_ms) < 3000 THEN 20
    WHEN AVG(pr.response_time_ms) < 5000 THEN 10
    ELSE 0
  END as response_time_score,
  -- Stability component (0-10 points)
  CASE 
    WHEN p.stability_status = 'Stable' THEN 10
    WHEN p.stability_status = 'UnstableHourly' THEN 5
    WHEN p.stability_status = 'UnstableDaily' THEN 0
    ELSE 0
  END as stability_score,
  -- Rotation component (0-10 points)
  CASE 
    WHEN p.rotation_status = 'Rotated' THEN 10
    WHEN p.rotation_status = 'NoRotation' THEN 0
    ELSE 5
  END as rotation_score,
  -- Total health score (0-100)
  (
    COALESCE(COUNT(CASE WHEN pr.status = 'SUCCESS' THEN 1 END) * 50.0 / NULLIF(COUNT(pr.id), 0), 0) +
    CASE 
      WHEN AVG(pr.response_time_ms) IS NULL THEN 0
      WHEN AVG(pr.response_time_ms) < 1000 THEN 30
      WHEN AVG(pr.response_time_ms) < 2000 THEN 25
      WHEN AVG(pr.response_time_ms) < 3000 THEN 20
      WHEN AVG(pr.response_time_ms) < 5000 THEN 10
      ELSE 0
    END +
    CASE 
      WHEN p.stability_status = 'Stable' THEN 10
      WHEN p.stability_status = 'UnstableHourly' THEN 5
      WHEN p.stability_status = 'UnstableDaily' THEN 0
      ELSE 0
    END +
    CASE 
      WHEN p.rotation_status = 'Rotated' THEN 10
      WHEN p.rotation_status = 'NoRotation' THEN 0
      ELSE 5
    END
  ) as health_score
FROM proxies p
LEFT JOIN proxy_requests pr ON p.device_id = pr.proxy_id
  AND pr.timestamp >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
WHERE p.active = true
GROUP BY p.device_id, p.name, p.location, p.stability_status, p.rotation_status;

-- ============================================
-- Usage Examples for Grafana
-- ============================================

-- Example 1: System-wide success rate over time
-- SELECT hour, success_rate FROM v_system_hourly_stats ORDER BY hour;

-- Example 2: Current stability breakdown
-- SELECT stability_status, proxy_count, percentage FROM v_stability_summary;

-- Example 3: Top 10 proxies by health score
-- SELECT name, location, health_score FROM v_proxy_health_score ORDER BY health_score DESC LIMIT 10;

-- Example 4: Error distribution
-- SELECT error_type, error_count, percentage FROM v_error_summary_24h;

-- Example 5: Location comparison
-- SELECT location, proxy_count, success_rate, avg_response_time FROM v_location_stats ORDER BY success_rate DESC;

