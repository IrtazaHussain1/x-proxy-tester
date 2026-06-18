-- Workstream A (JE-446): expand ip_rotation_6h_summary from Phase 0 stub to full schema.
-- Additive only — no existing columns or tables are modified.
-- Phase 0 stub already created: bucket_start, proxy_id, cycle_type, bucket_end,
--   attempts, first_ip_before, last_ip_after, auto_ip_change_count, created_at, updated_at.

ALTER TABLE `ip_rotation_6h_summary`
  ADD COLUMN `success_count`              INT            NOT NULL DEFAULT 0            AFTER `attempts`,
  ADD COLUMN `failed_count`               INT            NOT NULL DEFAULT 0            AFTER `success_count`,
  ADD COLUMN `success_rate_pct`           DECIMAL(5,2)   NULL                          AFTER `failed_count`,
  ADD COLUMN `commanded_ip_change_count`  INT            NOT NULL DEFAULT 0            AFTER `auto_ip_change_count`,
  ADD COLUMN `same_ip_count`              INT            NOT NULL DEFAULT 0            AFTER `commanded_ip_change_count`,
  ADD COLUMN `failed_but_ip_changed_count` INT           NOT NULL DEFAULT 0            AFTER `same_ip_count`,
  ADD COLUMN `ip_change_total`            INT            NOT NULL DEFAULT 0            AFTER `last_ip_after`,
  ADD COLUMN `ip_change_rate_pct`         DECIMAL(5,2)   NULL                          AFTER `ip_change_total`,
  ADD COLUMN `wasted_rotation_pct`        DECIMAL(5,2)   NULL                          AFTER `ip_change_rate_pct`,
  ADD COLUMN `anomaly_rate_pct`           DECIMAL(5,2)   NULL                          AFTER `wasted_rotation_pct`,
  ADD COLUMN `distinct_ips_before`        INT            NOT NULL DEFAULT 0            AFTER `anomaly_rate_pct`,
  ADD COLUMN `distinct_ips_total`         INT            NOT NULL DEFAULT 0            AFTER `distinct_ips_before`,
  ADD COLUMN `rotation_pool_class`        VARCHAR(16)    NULL                          AFTER `distinct_ips_total`,
  ADD COLUMN `max_consecutive_same_ip`    INT            NOT NULL DEFAULT 0            AFTER `rotation_pool_class`,
  ADD COLUMN `avg_rotation_duration_ms`   DECIMAL(10,2)  NULL                          AFTER `max_consecutive_same_ip`,
  ADD COLUMN `p95_rotation_duration_ms`   INT            NULL                          AFTER `avg_rotation_duration_ms`,
  ADD COLUMN `max_rotation_duration_ms`   INT            NULL                          AFTER `p95_rotation_duration_ms`,
  ADD COLUMN `avg_wait_time_ms`           DECIMAL(10,2)  NULL                          AFTER `max_rotation_duration_ms`,
  ADD COLUMN `total_retry_count`          INT            NOT NULL DEFAULT 0            AFTER `avg_wait_time_ms`,
  ADD COLUMN `pre_rotation_anomaly_count` INT            NOT NULL DEFAULT 0            AFTER `total_retry_count`,
  ADD COLUMN `distinct_error_count`       INT            NOT NULL DEFAULT 0            AFTER `pre_rotation_anomaly_count`,
  ADD COLUMN `last_error`                 TEXT           NULL                          AFTER `distinct_error_count`,
  ADD COLUMN `server_name`                VARCHAR(32)    NULL                          AFTER `last_error`,
  ADD COLUMN `device_name`                VARCHAR(255)   NULL                          AFTER `server_name`,
  ADD COLUMN `location`                   VARCHAR(255)   NULL                          AFTER `device_name`,
  ADD COLUMN `state`                      VARCHAR(255)   NULL                          AFTER `location`,
  ADD COLUMN `city`                       VARCHAR(255)   NULL                          AFTER `state`,
  ADD COLUMN `first_rotation_at`          DATETIME       NULL                          AFTER `city`,
  ADD COLUMN `last_rotation_at`           DATETIME       NULL                          AFTER `first_rotation_at`,
  ADD COLUMN `is_complete`                TINYINT(1)     NOT NULL DEFAULT 0            AFTER `last_rotation_at`,
  ADD COLUMN `aggregation_version`        INT            NOT NULL DEFAULT 1            AFTER `is_complete`;

-- Indexes
CREATE INDEX `ip_rotation_6h_summary_bucket_start_idx`
  ON `ip_rotation_6h_summary` (`bucket_start`);

CREATE INDEX `ip_rotation_6h_summary_proxy_id_bucket_start_idx`
  ON `ip_rotation_6h_summary` (`proxy_id`, `bucket_start`);

CREATE INDEX `ip_rotation_6h_summary_server_name_idx`
  ON `ip_rotation_6h_summary` (`server_name`);

CREATE INDEX `ip_rotation_6h_summary_location_idx`
  ON `ip_rotation_6h_summary` (`location`);

CREATE INDEX `ip_rotation_6h_summary_bucket_start_cycle_type_idx`
  ON `ip_rotation_6h_summary` (`bucket_start`, `cycle_type`);
