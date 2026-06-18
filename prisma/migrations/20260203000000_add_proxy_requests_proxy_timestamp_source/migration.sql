CREATE INDEX `idx_proxy_requests_proxy_timestamp_source`
ON `proxy_requests`(`proxy_id`, `timestamp`, `source`);
