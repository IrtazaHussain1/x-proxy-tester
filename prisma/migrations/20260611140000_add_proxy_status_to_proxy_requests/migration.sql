-- Snapshot proxy state at request time for online/offline analytics in daily summary.
-- Additive only. Existing rows get NULL (unknown historical state — expected and safe).

ALTER TABLE `proxy_requests`
  ADD COLUMN `proxy_status` VARCHAR(191) NULL AFTER `server_name`,
  ADD COLUMN `ws_status`    VARCHAR(191) NULL AFTER `proxy_status`;
