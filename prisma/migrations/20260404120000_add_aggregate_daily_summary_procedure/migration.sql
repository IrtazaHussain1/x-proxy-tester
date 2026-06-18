-- Stored procedure for daily aggregation (must live in migrations; Prisma applies as one script batch).
DROP PROCEDURE IF EXISTS aggregate_daily_summary;

CREATE PROCEDURE aggregate_daily_summary(IN summary_day DATE)
BEGIN
  INSERT INTO proxy_requests_daily_summary (
    day,
    proxy_id,
    location,
    relay_server_id,
    relay_server_ip,
    total_requests,
    success_count,
    failure_count,
    success_rate_pct,
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
    ip_diversity_score
  )
  SELECT
    DATE(pr.timestamp) AS day,
    pr.proxy_id,
    p.location,
    p.relay_server_id,
    p.relay_server_ip_address,
    COUNT(*) AS total_requests,
    COUNT(CASE WHEN pr.status = 'SUCCESS' THEN 1 END) AS success_count,
    COUNT(CASE WHEN pr.status != 'SUCCESS' THEN 1 END) AS failure_count,
    ROUND(COUNT(CASE WHEN pr.status = 'SUCCESS' THEN 1 END) / COUNT(*) * 100, 2) AS success_rate_pct,
    AVG(pr.response_time_ms) AS avg_response_time_ms,
    MIN(pr.response_time_ms) AS min_response_time_ms,
    MAX(pr.response_time_ms) AS max_response_time_ms,
    (SELECT sub.response_time_ms FROM (
      SELECT response_time_ms,
             ROW_NUMBER() OVER (ORDER BY response_time_ms) AS rn,
             COUNT(*) OVER () AS total
      FROM proxy_requests pr2
      WHERE DATE(pr2.timestamp) = summary_day
        AND pr2.proxy_id = pr.proxy_id
        AND pr2.response_time_ms IS NOT NULL
    ) sub WHERE sub.rn = FLOOR(sub.total * 0.50) + 1 LIMIT 1) AS p50_response_time_ms,
    (SELECT sub.response_time_ms FROM (
      SELECT response_time_ms,
             ROW_NUMBER() OVER (ORDER BY response_time_ms) AS rn,
             COUNT(*) OVER () AS total
      FROM proxy_requests pr3
      WHERE DATE(pr3.timestamp) = summary_day
        AND pr3.proxy_id = pr.proxy_id
        AND pr3.response_time_ms IS NOT NULL
    ) sub WHERE sub.rn = FLOOR(sub.total * 0.95) + 1 LIMIT 1) AS p95_response_time_ms,
    (SELECT sub.response_time_ms FROM (
      SELECT response_time_ms,
             ROW_NUMBER() OVER (ORDER BY response_time_ms) AS rn,
             COUNT(*) OVER () AS total
      FROM proxy_requests pr4
      WHERE DATE(pr4.timestamp) = summary_day
        AND pr4.proxy_id = pr.proxy_id
        AND pr4.response_time_ms IS NOT NULL
    ) sub WHERE sub.rn = FLOOR(sub.total * 0.99) + 1 LIMIT 1) AS p99_response_time_ms,
    COUNT(CASE WHEN pr.status = 'TIMEOUT' THEN 1 END) AS timeout_count,
    COUNT(CASE WHEN pr.status = 'CONNECTION_ERROR' THEN 1 END) AS connection_error_count,
    COUNT(CASE WHEN pr.status = 'HTTP_ERROR' THEN 1 END) AS http_error_count,
    COUNT(CASE WHEN pr.status = 'DNS_ERROR' THEN 1 END) AS dns_error_count,
    COUNT(CASE WHEN pr.ip_changed = TRUE THEN 1 END) AS rotation_count,
    AVG(pr.download_speed_mbps) AS avg_download_speed_mbps,
    AVG(pr.upload_speed_mbps) AS avg_upload_speed_mbps,
    MAX(pr.download_speed_mbps) AS max_download_speed_mbps,
    MAX(pr.upload_speed_mbps) AS max_upload_speed_mbps,
    MIN(pr.download_speed_mbps) AS min_download_speed_mbps,
    MIN(pr.upload_speed_mbps) AS min_upload_speed_mbps,
    COUNT(DISTINCT pr.outbound_ip) AS unique_ips_count,
    ROUND(COUNT(DISTINCT pr.outbound_ip) / COUNT(*) * 100, 2) AS ip_diversity_score
  FROM proxy_requests pr
  LEFT JOIN proxies p ON pr.proxy_id = p.device_id
  WHERE DATE(pr.timestamp) = summary_day
    AND pr.timestamp IS NOT NULL
  GROUP BY DATE(pr.timestamp), pr.proxy_id, p.location, p.relay_server_id, p.relay_server_ip_address
  ON DUPLICATE KEY UPDATE
    relay_server_id = VALUES(relay_server_id),
    relay_server_ip = VALUES(relay_server_ip),
    total_requests = VALUES(total_requests),
    success_count = VALUES(success_count),
    failure_count = VALUES(failure_count),
    success_rate_pct = VALUES(success_rate_pct),
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
    ip_diversity_score = VALUES(ip_diversity_score),
    updated_at = CURRENT_TIMESTAMP;
END;
