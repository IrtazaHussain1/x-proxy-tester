-- Fix v_daily_summary: add the 4 ip_rotation_*_count columns that were missing
-- from the initial view definition in migration 20260416103000.

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
  ip_rotation_periodic_success_count,
  ip_rotation_periodic_failure_count,
  ip_rotation_continuous_success_count,
  ip_rotation_continuous_failure_count,
  avg_download_speed_mbps,
  avg_upload_speed_mbps,
  max_download_speed_mbps,
  max_upload_speed_mbps,
  min_download_speed_mbps,
  min_upload_speed_mbps,
  unique_ips_count
FROM proxy_requests_daily_summary
ORDER BY day DESC, proxy_id;
