-- Stored computed server label (e.g. S48) derived from device name.
-- Eliminates regexp extraction in Grafana dashboards.

ALTER TABLE `proxies`
  ADD COLUMN `server_name` VARCHAR(32) NULL AFTER `name`;
