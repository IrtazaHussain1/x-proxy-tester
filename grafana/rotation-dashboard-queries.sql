-- Rotation dashboard queries rewritten to use Grafana SQL views.
-- Variables like $location, $limit, and $__timeFilter are Grafana macros.

-- Proxies with Rotation
SELECT COUNT(*) AS value
FROM v_rotation_stats
WHERE active = true
  AND rotation_status = 'Rotated'
  AND location IN ($location);

-- Proxies with No Rotation
SELECT COUNT(*) AS value
FROM v_rotation_stats
WHERE active = true
  AND rotation_status = 'NoRotation'
  AND location IN ($location);

-- Total Rotations (24h) using pre-aggregated view
SELECT COALESCE(SUM(rotation_count_24h), 0) AS value
FROM v_proxy_summary
WHERE active = true
  AND location IN ($location);

-- Never Rotated
SELECT COUNT(*) AS value
FROM v_rotation_stats
WHERE active = true
  AND rotation_count = 0
  AND last_rotation_at IS NULL
  AND location IN ($location);

-- Rotation Events Over Time (uses v_recent_rotations + v_rotation_stats for active filter)
SELECT
  UNIX_TIMESTAMP(DATE_FORMAT(rr.timestamp, '%Y-%m-%d %H:%i:00')) AS time_sec,
  COUNT(*) AS rotation_count
FROM v_recent_rotations rr
JOIN v_rotation_stats rs ON rr.proxy_id = rs.device_id
WHERE $__timeFilter(rr.timestamp)
  AND rs.active = true
  AND rr.location IN ($location)
GROUP BY time_sec
ORDER BY time_sec;

-- Rotation Status Distribution
SELECT rotation_status AS metric, COUNT(*) AS value
FROM v_rotation_stats
WHERE active = true
  AND location IN ($location)
GROUP BY rotation_status;

-- Proxies with High Same IP Count (Potential Rotation Issues)
SELECT
  name,
  location,
  last_ip,
  same_ip_count,
  rotation_count,
  rotation_status,
  last_rotation_at,
  updated_at
FROM v_rotation_stats
WHERE active = true
  AND same_ip_count >= 10
  AND location IN ($location)
ORDER BY same_ip_count DESC
LIMIT $limit;
