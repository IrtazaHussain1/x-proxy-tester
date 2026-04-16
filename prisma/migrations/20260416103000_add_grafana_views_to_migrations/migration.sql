-- Migration: Move Grafana view creation to Prisma migrations
-- This keeps view lifecycle in schema history instead of runtime bootstrapping.

-- SQL Views for Grafana Dashboards
-- These views pre-aggregate data to improve query performance

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
  COUNT(pr.id) as total_requests_24h,
  COUNT(CASE WHEN pr.status = 'SUCCESS' THEN 1 END) as success_count_24h,
  COUNT(CASE WHEN pr.status != 'SUCCESS' THEN 1 END) as failure_count_24h,
  COUNT(CASE WHEN pr.status = 'SUCCESS' THEN 1 END) * 100.0 / NULLIF(COUNT(pr.id), 0) as success_rate_24h,
  AVG(pr.response_time_ms) as avg_response_time_24h,
  MIN(pr.response_time_ms) as min_response_time_24h,
  MAX(pr.response_time_ms) as max_response_time_24h,
  COUNT(CASE WHEN pr.ip_changed = true THEN 1 END) as rotation_count_24h,
  COUNT(CASE WHEN pr.timestamp >= DATE_SUB(NOW(), INTERVAL 1 HOUR) THEN 1 END) as total_requests_1h,
  COUNT(CASE WHEN pr.timestamp >= DATE_SUB(NOW(), INTERVAL 1 HOUR) AND pr.status = 'SUCCESS' THEN 1 END) as success_count_1h,
  COUNT(CASE WHEN pr.timestamp >= DATE_SUB(NOW(), INTERVAL 1 HOUR) AND pr.status = 'SUCCESS' THEN 1 END) * 100.0 / NULLIF(COUNT(CASE WHEN pr.timestamp >= DATE_SUB(NOW(), INTERVAL 1 HOUR) THEN 1 END), 0) as success_rate_1h
FROM proxies p
LEFT JOIN proxy_requests pr ON p.device_id = pr.proxy_id
  AND pr.timestamp >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
  AND pr.timestamp IS NOT NULL
WHERE p.active = true
GROUP BY 
  p.device_id, p.name, p.location, p.host, p.port, p.active,
  p.stability_status, p.rotation_status, p.last_ip, p.same_ip_count,
  p.rotation_count, p.last_rotation_at, p.created_at, p.updated_at;

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
WHERE timestamp >= DATE_SUB(NOW(), INTERVAL 7 DAY)
  AND timestamp IS NOT NULL
GROUP BY hour, proxy_id
ORDER BY hour DESC, proxy_id;

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
WHERE timestamp >= DATE_SUB(NOW(), INTERVAL 7 DAY)
  AND timestamp IS NOT NULL
GROUP BY hour
ORDER BY hour DESC;

CREATE OR REPLACE VIEW v_stability_summary AS
SELECT 
  stability_status,
  COUNT(*) as proxy_count,
  COUNT(*) * 100.0 / (SELECT COUNT(*) FROM proxies WHERE active = true) as percentage
FROM proxies
WHERE active = true
GROUP BY stability_status;

CREATE OR REPLACE VIEW v_rotation_stats AS
WITH ordered_requests AS (
  SELECT
    pr.proxy_id,
    pr.outbound_ip,
    pr.timestamp,
    CASE
      WHEN pr.outbound_ip = LAG(pr.outbound_ip) OVER (PARTITION BY pr.proxy_id ORDER BY pr.timestamp DESC) THEN 0
      ELSE 1
    END AS change_flag
  FROM proxy_requests pr
  WHERE pr.outbound_ip IS NOT NULL
    AND pr.status = 'SUCCESS'
),
same_ip AS (
  SELECT
    proxy_id,
    outbound_ip AS last_ip,
    COUNT(*) AS same_ip_count
  FROM (
    SELECT
      proxy_id,
      outbound_ip,
      SUM(change_flag) OVER (PARTITION BY proxy_id ORDER BY timestamp DESC) AS grp
    FROM ordered_requests
  ) grouped
  WHERE grp = 1
  GROUP BY proxy_id, outbound_ip
),
rotation_counts AS (
  SELECT
    proxy_id,
    COUNT(*) AS rotation_count,
    MAX(timestamp) AS last_rotation_at
  FROM proxy_requests
  WHERE ip_changed = true
  GROUP BY proxy_id
)
SELECT
  p.device_id,
  p.name,
  p.location,
  p.city,
  p.active,
  p.stability_status,
  p.version,
  p.updated_at,
  COALESCE(si.same_ip_count, 0) AS same_ip_count,
  si.last_ip,
  COALESCE(rc.rotation_count, 0) AS rotation_count,
  rc.last_rotation_at,
  CASE
    WHEN COALESCE(si.same_ip_count, 0) >= 10 THEN 'NoRotation'
    WHEN rc.last_rotation_at IS NOT NULL THEN 'Rotated'
    ELSE 'Unknown'
  END AS rotation_status
FROM proxies p
LEFT JOIN same_ip si ON p.device_id = si.proxy_id
LEFT JOIN rotation_counts rc ON p.device_id = rc.proxy_id;

CREATE OR REPLACE VIEW v_rotation_summary AS
SELECT 
  rotation_status,
  COUNT(*) as proxy_count,
  AVG(rotation_count) as avg_rotation_count,
  AVG(same_ip_count) as avg_same_ip_count,
  MAX(same_ip_count) as max_same_ip_count
FROM v_rotation_stats
WHERE active = true
GROUP BY rotation_status;

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
  AND pr.timestamp IS NOT NULL
  AND p.active = true
GROUP BY p.device_id, p.name, p.location, p.stability_status, p.rotation_status
HAVING total_requests >= 50
ORDER BY success_rate DESC, avg_response_time ASC
LIMIT 50;

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
  AND pr.timestamp IS NOT NULL
  AND p.active = true
GROUP BY p.device_id, p.name, p.location, p.stability_status, p.rotation_status
HAVING total_requests >= 50
ORDER BY success_rate ASC, failure_count DESC
LIMIT 50;

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
  AND pr.timestamp IS NOT NULL
ORDER BY pr.timestamp DESC
LIMIT 1000;

CREATE OR REPLACE VIEW v_proxy_health_score AS
SELECT 
  p.device_id,
  p.name,
  p.location,
  p.stability_status,
  p.rotation_status,
  COALESCE(
    COUNT(CASE WHEN pr.status = 'SUCCESS' THEN 1 END) * 50.0 / NULLIF(COUNT(pr.id), 0),
    0
  ) as success_rate_score,
  CASE 
    WHEN AVG(pr.response_time_ms) IS NULL THEN 0
    WHEN AVG(pr.response_time_ms) < 1000 THEN 30
    WHEN AVG(pr.response_time_ms) < 2000 THEN 25
    WHEN AVG(pr.response_time_ms) < 3000 THEN 20
    WHEN AVG(pr.response_time_ms) < 5000 THEN 10
    ELSE 0
  END as response_time_score,
  CASE 
    WHEN p.stability_status = 'Stable' THEN 10
    WHEN p.stability_status = 'UnstableHourly' THEN 5
    WHEN p.stability_status = 'UnstableDaily' THEN 0
    ELSE 0
  END as stability_score,
  CASE 
    WHEN p.rotation_status = 'Rotated' THEN 10
    WHEN p.rotation_status = 'NoRotation' THEN 0
    ELSE 5
  END as rotation_score,
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

CREATE OR REPLACE VIEW v_daily_summary AS
SELECT 
  day,
  proxy_id,
  location,
  total_requests,
  success_count,
  failure_count,
  success_count * 100.0 / NULLIF(total_requests, 0) as success_rate,
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
FROM proxy_requests_daily_summary
ORDER BY day DESC, proxy_id;

CREATE OR REPLACE VIEW v_system_daily_stats AS
SELECT 
  day,
  SUM(total_requests) as total_requests,
  COUNT(DISTINCT proxy_id) as active_proxies,
  SUM(success_count) as success_count,
  SUM(failure_count) as failure_count,
  SUM(success_count) * 100.0 / NULLIF(SUM(total_requests), 0) as success_rate,
  AVG(avg_response_time_ms) as avg_response_time,
  MIN(min_response_time_ms) as min_response_time,
  MAX(max_response_time_ms) as max_response_time,
  AVG(p50_response_time_ms) as avg_p50_response_time,
  AVG(p95_response_time_ms) as avg_p95_response_time,
  AVG(p99_response_time_ms) as avg_p99_response_time,
  SUM(rotation_count) as total_rotations,
  SUM(timeout_count) as timeout_count,
  SUM(connection_error_count) as connection_error_count,
  SUM(http_error_count) as http_error_count,
  SUM(dns_error_count) as dns_error_count,
  AVG(avg_download_speed_mbps) as avg_download_speed,
  AVG(avg_upload_speed_mbps) as avg_upload_speed,
  SUM(unique_ips_count) as total_unique_ips
FROM proxy_requests_daily_summary
GROUP BY day
ORDER BY day DESC;

CREATE OR REPLACE VIEW v_location_daily_stats AS
SELECT 
  day,
  location,
  COUNT(DISTINCT proxy_id) as proxy_count,
  SUM(total_requests) as total_requests,
  SUM(success_count) * 100.0 / NULLIF(SUM(total_requests), 0) as success_rate,
  AVG(avg_response_time_ms) as avg_response_time,
  MIN(min_response_time_ms) as min_response_time,
  MAX(max_response_time_ms) as max_response_time,
  AVG(avg_download_speed_mbps) as avg_download_speed,
  AVG(avg_upload_speed_mbps) as avg_upload_speed,
  SUM(rotation_count) as total_rotations
FROM proxy_requests_daily_summary
GROUP BY day, location
ORDER BY day DESC, location;

CREATE OR REPLACE VIEW v_proxy_requests_combined AS
SELECT 
  DATE_FORMAT(pr.timestamp, '%Y-%m-%d %H:00:00') as timestamp,
  pr.proxy_id,
  p.location,
  COUNT(*) as total_requests,
  COUNT(CASE WHEN pr.status = 'SUCCESS' THEN 1 END) as success_count,
  COUNT(CASE WHEN pr.status != 'SUCCESS' THEN 1 END) as failure_count,
  AVG(pr.response_time_ms) as avg_response_time_ms,
  MIN(pr.response_time_ms) as min_response_time_ms,
  MAX(pr.response_time_ms) as max_response_time_ms,
  NULL as p50_response_time_ms,
  NULL as p95_response_time_ms,
  NULL as p99_response_time_ms,
  COUNT(CASE WHEN pr.status = 'TIMEOUT' THEN 1 END) as timeout_count,
  COUNT(CASE WHEN pr.status = 'CONNECTION_ERROR' THEN 1 END) as connection_error_count,
  COUNT(CASE WHEN pr.status = 'HTTP_ERROR' THEN 1 END) as http_error_count,
  COUNT(CASE WHEN pr.status = 'DNS_ERROR' THEN 1 END) as dns_error_count,
  COUNT(CASE WHEN pr.ip_changed = true THEN 1 END) as rotation_count,
  AVG(pr.download_speed_mbps) as avg_download_speed_mbps,
  AVG(pr.upload_speed_mbps) as avg_upload_speed_mbps,
  NULL as max_download_speed_mbps,
  NULL as max_upload_speed_mbps,
  NULL as min_download_speed_mbps,
  NULL as min_upload_speed_mbps,
  NULL as unique_ips_count,
  'hourly' as aggregation_level
FROM proxy_requests pr
LEFT JOIN proxies p ON pr.proxy_id = p.device_id
WHERE pr.timestamp >= DATE_SUB(NOW(), INTERVAL 14 DAY)
  AND pr.timestamp IS NOT NULL
GROUP BY DATE_FORMAT(pr.timestamp, '%Y-%m-%d %H:00:00'), pr.proxy_id, p.location

UNION ALL

SELECT 
  CONCAT(day, ' 12:00:00') as timestamp,
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
  unique_ips_count,
  'daily' as aggregation_level
FROM proxy_requests_daily_summary
WHERE day < DATE_SUB(NOW(), INTERVAL 14 DAY)
ORDER BY timestamp DESC, proxy_id;

CREATE OR REPLACE VIEW v_proxy_requests_24h_optimized AS
SELECT 
  DATE_FORMAT(pr.timestamp, '%Y-%m-%d %H:00:00') as timestamp,
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
WHERE pr.timestamp >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
  AND pr.timestamp IS NOT NULL
GROUP BY DATE_FORMAT(pr.timestamp, '%Y-%m-%d %H:00:00'), pr.proxy_id, p.location
ORDER BY timestamp DESC, pr.proxy_id;

CREATE OR REPLACE VIEW v_system_hourly_stats_optimized AS
SELECT 
  DATE_FORMAT(timestamp, '%Y-%m-%d %H:00:00') as hour,
  COUNT(*) as total_requests,
  COUNT(DISTINCT proxy_id) as active_proxies,
  COUNT(CASE WHEN status = 'SUCCESS' THEN 1 END) as success_count,
  COUNT(CASE WHEN status != 'SUCCESS' THEN 1 END) as failure_count,
  COUNT(CASE WHEN status = 'SUCCESS' THEN 1 END) * 100.0 / NULLIF(COUNT(*), 0) as success_rate,
  AVG(response_time_ms) as avg_response_time,
  MIN(response_time_ms) as min_response_time,
  MAX(response_time_ms) as max_response_time,
  COUNT(CASE WHEN ip_changed = true THEN 1 END) as total_rotations,
  COUNT(CASE WHEN status = 'TIMEOUT' THEN 1 END) as timeout_count,
  COUNT(CASE WHEN status = 'CONNECTION_ERROR' THEN 1 END) as connection_error_count,
  COUNT(CASE WHEN status = 'HTTP_ERROR' THEN 1 END) as http_error_count,
  COUNT(CASE WHEN status = 'DNS_ERROR' THEN 1 END) as dns_error_count
FROM proxy_requests
WHERE timestamp >= DATE_SUB(NOW(), INTERVAL 7 DAY)
  AND timestamp IS NOT NULL
GROUP BY DATE_FORMAT(timestamp, '%Y-%m-%d %H:00:00')
ORDER BY hour DESC;

CREATE OR REPLACE VIEW v_location_stats_optimized AS
SELECT 
  p.location,
  COUNT(DISTINCT pr.proxy_id) as proxy_count,
  COUNT(*) as total_requests,
  COUNT(CASE WHEN pr.status = 'SUCCESS' THEN 1 END) * 100.0 / NULLIF(COUNT(*), 0) as success_rate,
  AVG(pr.response_time_ms) as avg_response_time,
  MIN(pr.response_time_ms) as min_response_time,
  MAX(pr.response_time_ms) as max_response_time,
  COUNT(CASE WHEN pr.ip_changed = true THEN 1 END) as total_rotations
FROM proxy_requests pr
LEFT JOIN proxies p ON pr.proxy_id = p.device_id
WHERE pr.timestamp >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
  AND pr.timestamp IS NOT NULL
GROUP BY p.location
ORDER BY success_rate DESC;

-- Rotation Cycle Aggregation Views
CREATE OR REPLACE VIEW v_rotation_cycles_summary AS
SELECT 
    id,
    cycle_type,
    cycle_timestamp,
    total_proxies,
    successful_count,
    failed_count,
    pending_count,
    status,
    CASE 
        WHEN total_proxies > 0 
        THEN (successful_count * 100.0 / total_proxies)
        ELSE 0 
    END as success_rate_percent,
    CASE 
        WHEN total_proxies > 0 
        THEN (failed_count * 100.0 / total_proxies)
        ELSE 0 
    END as failure_rate_percent,
    created_at,
    updated_at
FROM rotation_cycles
ORDER BY cycle_timestamp DESC;

CREATE OR REPLACE VIEW v_daily_rotation_stats AS
SELECT 
    DATE(cycle_timestamp) as day,
    cycle_type,
    COUNT(*) as total_cycles,
    SUM(total_proxies) as total_rotations_attempted,
    SUM(successful_count) as total_successful,
    SUM(failed_count) as total_failed,
    SUM(pending_count) as total_pending,
    AVG(CASE 
        WHEN total_proxies > 0 
        THEN (successful_count * 100.0 / total_proxies)
        ELSE 0 
    END) as avg_success_rate_percent
FROM rotation_cycles
GROUP BY DATE(cycle_timestamp), cycle_type
ORDER BY day DESC, cycle_type;

CREATE OR REPLACE VIEW v_rotation_details AS
SELECT 
    ir.id,
    ir.cycle_id,
    rc.cycle_type,
    rc.cycle_timestamp,
    ir.proxy_id,
    p.name as proxy_name,
    p.location,
    ir.rotation_type,
    ir.command_sent_at,
    ir.ip_before,
    ir.ip_after,
    ir.status_before,
    ir.status_after,
    ir.ws_status_before,
    ir.ws_status_after,
    ir.success,
    ir.verification_method,
    ir.verified_at,
    ir.wait_time_ms,
    ir.rotation_duration_ms,
    ir.retry_count,
    ir.error_message,
    TIMESTAMPDIFF(SECOND, ir.command_sent_at, ir.verified_at) as verification_duration_seconds
FROM ip_rotations ir
JOIN rotation_cycles rc ON ir.cycle_id = rc.id
LEFT JOIN proxies p ON ir.proxy_id = p.device_id
ORDER BY ir.rotation_timestamp DESC, ir.command_sent_at DESC;

CREATE OR REPLACE VIEW v_proxy_rotation_history AS
SELECT 
    proxy_id,
    p.name as proxy_name,
    p.location,
    COUNT(*) as total_rotations,
    SUM(CASE WHEN success = true THEN 1 ELSE 0 END) as successful_rotations,
    SUM(CASE WHEN success = false THEN 1 ELSE 0 END) as failed_rotations,
    AVG(CASE WHEN rotation_duration_ms IS NOT NULL THEN rotation_duration_ms ELSE NULL END) as avg_rotation_duration_ms,
    AVG(CASE WHEN wait_time_ms IS NOT NULL THEN wait_time_ms ELSE NULL END) as avg_wait_time_ms,
    MAX(rotation_timestamp) as last_rotation_at,
    MIN(rotation_timestamp) as first_rotation_at
FROM ip_rotations ir
LEFT JOIN proxies p ON ir.proxy_id = p.device_id
GROUP BY proxy_id, p.name, p.location
ORDER BY total_rotations DESC;

CREATE OR REPLACE VIEW v_hourly_rotation_stats AS
SELECT 
    DATE_FORMAT(cycle_timestamp, '%Y-%m-%d %H:00:00') as hour,
    cycle_type,
    COUNT(*) as cycles_count,
    SUM(total_proxies) as total_rotations_attempted,
    SUM(successful_count) as total_successful,
    SUM(failed_count) as total_failed,
    AVG(CASE 
        WHEN total_proxies > 0 
        THEN (successful_count * 100.0 / total_proxies)
        ELSE 0 
    END) as avg_success_rate_percent
FROM rotation_cycles
GROUP BY DATE_FORMAT(cycle_timestamp, '%Y-%m-%d %H:00:00'), cycle_type
ORDER BY hour DESC, cycle_type;
