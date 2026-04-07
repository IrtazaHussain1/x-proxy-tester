-- Increase speed column precision in proxy_requests_daily_summary from DECIMAL(10,2)
-- to DECIMAL(10,4) to preserve 4 decimal places (e.g. 2.2321 instead of 2.23).
-- MySQL ALTER TABLE MODIFY is non-destructive for a precision increase — no data lost.

ALTER TABLE `proxy_requests_daily_summary`
  MODIFY COLUMN `avg_download_speed_mbps` DECIMAL(10,4) NULL,
  MODIFY COLUMN `avg_upload_speed_mbps`   DECIMAL(10,4) NULL,
  MODIFY COLUMN `max_download_speed_mbps` DECIMAL(10,4) NULL,
  MODIFY COLUMN `max_upload_speed_mbps`   DECIMAL(10,4) NULL,
  MODIFY COLUMN `min_download_speed_mbps` DECIMAL(10,4) NULL,
  MODIFY COLUMN `min_upload_speed_mbps`   DECIMAL(10,4) NULL;
