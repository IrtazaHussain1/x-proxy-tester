-- JE-446 addendum: per-proxy IP frequency snapshot for pool analysis panels.
-- [{"ip":"1.2.3.4","count":4},{"ip":"1.2.3.5","count":2},...] sorted desc by count.

ALTER TABLE `ip_rotation_6h_summary`
  ADD COLUMN `ip_pool_snapshot` JSON NULL AFTER `aggregation_version`;
