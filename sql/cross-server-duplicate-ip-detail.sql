-- Cross-Server Duplicate IP — Per-Phone Detail (Grafana panel)
-- Replace ${proxy_status} with active or all when running outside Grafana.
-- In Grafana: ('${proxy_status}' = 'all' OR p.proxy_status = '${proxy_status}')

SELECT
  x.last_ip,
  GROUP_CONCAT(DISTINCT x.location ORDER BY x.location SEPARATOR ' | ') AS location,
  MAX(dup.all_servers_on_ip) AS all_servers_on_ip,
  MAX(dup.phones_on_same_ip) AS phones_on_same_ip,
  MAX(dup.sibling_phones) AS sibling_phones,
  GROUP_CONCAT(x.name ORDER BY x.name SEPARATOR ' | ') AS phone_names,
  GROUP_CONCAT(x.device_id ORDER BY x.name SEPARATOR ' | ') AS device_ids
FROM (
  SELECT
    p.name,
    p.device_id,
    p.last_ip,
    p.proxy_status,
    CONCAT_WS(', ', NULLIF(TRIM(p.city), ''), NULLIF(TRIM(p.state), ''), NULLIF(TRIM(p.country), '')) AS location
  FROM proxies p
  WHERE p.last_ip IS NOT NULL AND p.last_ip != ''
    AND ('${proxy_status}' = 'all' OR p.proxy_status = '${proxy_status}')
) x
JOIN (
  SELECT
    last_ip,
    COUNT(*) AS phones_on_same_ip,
    GROUP_CONCAT(
      DISTINCT CASE WHEN UPPER(name) REGEXP '^S[0-9]+' THEN CONCAT('S', SUBSTRING_INDEX(SUBSTRING_INDEX(UPPER(name), 'P', 1), 'S', -1)) ELSE 'Unknown' END
      ORDER BY CASE WHEN UPPER(name) REGEXP '^S[0-9]+' THEN CAST(SUBSTRING_INDEX(SUBSTRING_INDEX(UPPER(name), 'P', 1), 'S', -1) AS UNSIGNED) ELSE 999999 END
      SEPARATOR ', '
    ) AS all_servers_on_ip,
    GROUP_CONCAT(name ORDER BY name SEPARATOR ' | ') AS sibling_phones
  FROM proxies
  WHERE last_ip IS NOT NULL AND last_ip != ''
    AND ('${proxy_status}' = 'all' OR proxy_status = '${proxy_status}')
  GROUP BY last_ip
  HAVING COUNT(*) > 1
) dup ON x.last_ip = dup.last_ip
GROUP BY x.last_ip
ORDER BY MAX(dup.phones_on_same_ip) DESC, x.last_ip;
