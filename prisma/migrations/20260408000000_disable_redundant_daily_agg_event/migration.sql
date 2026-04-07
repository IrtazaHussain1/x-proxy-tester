-- Disable the daily_aggregate_summary MySQL EVENT.
-- The Node.js daily-aggregation service (runs at 01:00 UTC) is the authoritative
-- aggregation path. The MySQL EVENT at 02:30 was a duplicate that silently overwrote
-- the Node.js result with a different implementation.
--
-- The manage_proxy_requests_partitions event (monthly partition management) is kept.
--
-- If this event does not exist yet (e.g. fresh install), the statement is safe to ignore.
ALTER EVENT IF EXISTS daily_aggregate_summary DISABLE;
