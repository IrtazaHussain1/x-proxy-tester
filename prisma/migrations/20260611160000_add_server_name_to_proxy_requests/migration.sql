-- Adds server_name to proxy_requests for analytics grouping and daily summary joins.
-- Column already exists on dev (historical); this migration brings prod into sync.

ALTER TABLE `proxy_requests`
  ADD COLUMN `server_name` VARCHAR(16) NULL AFTER `source`;
