-- Derived proxy-state analytics for proxy_requests_daily_summary.
-- Requires proxy_status + ws_status to be populated on proxy_requests (migration 20260611140000).
-- Historical rows (before that migration) will have 0 / NULL — expected and safe.

ALTER TABLE `proxy_requests_daily_summary`
  ADD COLUMN `inactive_request_count` INT           NOT NULL DEFAULT 0    AFTER `most_used_ip_count`,
  ADD COLUMN `inactive_request_pct`   DECIMAL(5,2)  NULL                  AFTER `inactive_request_count`,
  ADD COLUMN `last_inactive_at`       DATETIME      NULL                  AFTER `inactive_request_pct`,
  ADD COLUMN `ws_disconnected_count`  INT           NOT NULL DEFAULT 0    AFTER `last_inactive_at`;
