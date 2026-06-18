-- Drop redundant indexes on proxy_requests that cause write amplification.
--
-- Each INSERT into proxy_requests updates every index listed here.
-- At ~33 inserts/sec these indexes add overhead with no meaningful query benefit:
--
-- Kept indexes (audited against full codebase):
--   PRIMARY (id, timestamp)                           -- required by partitioning
--   proxy_requests_proxy_id_timestamp_idx             -- primary access pattern
--   idx_proxy_requests_proxy_timestamp_source         -- rotation-verification source filter
--   proxy_requests_timestamp_idx                      -- partition management + cutoff queries
--   proxy_requests_outbound_ip_idx                    -- rotation-verification fallback query
--
-- Dropped indexes (reverse-order duplicate or never used as primary filter):
--   proxy_requests_timestamp_proxy_id_idx   -- reverse of (proxyId,timestamp), unused query pattern
--   proxy_requests_status_idx               -- 5-value low-cardinality column, MySQL ignores it
--   proxy_requests_expected_ip_idx          -- never used as a primary filter
--   proxy_requests_ip_changed_idx           -- boolean column index, useless cardinality
--   proxy_requests_source_idx               -- covered by composite (proxyId,timestamp,source)
--   proxy_requests_created_at_idx           -- only used in dev debug scripts
--   proxy_requests_updated_at_idx           -- never queried in any path
--
-- Run `SHOW INDEX FROM proxy_requests;` first to verify exact index names before executing.
-- These names follow Prisma's auto-generated convention from the @@index declarations.

-- NOTE: ALTER TABLE on a partitioned InnoDB table drops indexes online (ALGORITHM=INPLACE)
-- in MySQL 8.0+ when the index is not the primary key. This should not block writes for long.
-- Schedule during a low-traffic window if possible.

ALTER TABLE `proxy_requests`
  DROP INDEX `proxy_requests_timestamp_proxy_id_idx`,
  DROP INDEX `proxy_requests_status_idx`,
  DROP INDEX `proxy_requests_expected_ip_idx`,
  DROP INDEX `proxy_requests_ip_changed_idx`,
  DROP INDEX `proxy_requests_source_idx`,
  DROP INDEX `proxy_requests_created_at_idx`,
  DROP INDEX `proxy_requests_updated_at_idx`;
