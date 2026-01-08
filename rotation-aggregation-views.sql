-- Rotation Cycle Aggregation Views
-- These views provide aggregated statistics for Grafana dashboards

-- View: Rotation cycles with success rates
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

-- View: Daily rotation statistics
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

-- View: Rotation details with proxy information
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

-- View: Proxy rotation history
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

-- View: Hourly rotation statistics
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

