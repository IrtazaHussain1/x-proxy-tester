-- Phase 0 spike: ip_rotation_6h_summary
-- Validates last_ip_after boundary chaining for JE-446 auto-change detection.
-- Intentionally kept after Phase 0 passes — Workstream A will replace with full schema.

CREATE TABLE IF NOT EXISTS `ip_rotation_6h_summary` (
  `bucket_start`         DATETIME(0)  NOT NULL,
  `proxy_id`             VARCHAR(255) NOT NULL,
  `cycle_type`           VARCHAR(50)  NOT NULL,
  `bucket_end`           DATETIME(0)  NOT NULL,
  `attempts`             INT          NOT NULL DEFAULT 0,
  `first_ip_before`      VARCHAR(45)  NULL,
  `last_ip_after`        VARCHAR(45)  NULL,
  `auto_ip_change_count` INT          NOT NULL DEFAULT 0,
  `created_at`           DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`           DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (`bucket_start`, `proxy_id`, `cycle_type`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
