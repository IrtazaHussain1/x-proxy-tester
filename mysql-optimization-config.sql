-- ============================================
-- MySQL Configuration Optimizations for Large Datasets (100K+ records)
-- ============================================
-- Run these SQL commands to optimize MySQL for handling large datasets
-- These settings improve query performance for Grafana dashboards

-- ============================================
-- 1. Increase Buffer Pool Size (if you have enough RAM)
-- ============================================
-- For 4GB RAM system, allocate 1.5GB to MySQL buffer pool
-- Adjust based on your available RAM
-- Note: This requires MySQL restart, add to my.cnf or use SET GLOBAL (if supported)

-- SET GLOBAL innodb_buffer_pool_size = 1536 * 1024 * 1024;  -- 1.5GB
-- Or add to my.cnf:
-- [mysqld]
-- innodb_buffer_pool_size = 1536M

-- ============================================
-- 2. Optimize Query Cache (MySQL 8.0+ removed query cache, skip if using 8.0+)
-- ============================================
-- MySQL 8.0 removed query cache, so skip this section

-- ============================================
-- 3. Increase Sort Buffer and Join Buffer
-- ============================================
-- These help with large JOIN operations and sorting
SET SESSION sort_buffer_size = 2 * 1024 * 1024;  -- 2MB per connection
SET SESSION join_buffer_size = 2 * 1024 * 1024;   -- 2MB per connection
SET SESSION read_buffer_size = 1 * 1024 * 1024;   -- 1MB per connection

-- ============================================
-- 4. Increase Max Connections (if needed)
-- ============================================
-- Default is usually 151, increase if you have many concurrent Grafana queries
-- SET GLOBAL max_connections = 200;

-- ============================================
-- 5. Optimize Temporary Tables
-- ============================================
-- For large GROUP BY and ORDER BY operations
SET SESSION tmp_table_size = 64 * 1024 * 1024;      -- 64MB
SET SESSION max_heap_table_size = 64 * 1024 * 1024; -- 64MB

-- ============================================
-- 6. Increase Table Open Cache
-- ============================================
-- Helps with view performance
SET GLOBAL table_open_cache = 2000;

-- ============================================
-- 7. Optimize InnoDB Settings
-- ============================================
-- For better write performance with large datasets
SET GLOBAL innodb_flush_log_at_trx_commit = 2;  -- Faster writes (slight risk on crash)
SET GLOBAL innodb_log_file_size = 256 * 1024 * 1024;  -- 256MB (requires restart)

-- ============================================
-- 8. Analyze Tables for Better Query Plans
-- ============================================
-- Run this periodically (weekly) to update statistics
-- ANALYZE TABLE proxy_requests;
-- ANALYZE TABLE proxies;

-- ============================================
-- Verification Queries
-- ============================================

-- Check current buffer pool size
-- SHOW VARIABLES LIKE 'innodb_buffer_pool_size';

-- Check index usage
-- SHOW INDEX FROM proxy_requests;

-- Check table statistics
-- SHOW TABLE STATUS LIKE 'proxy_requests';

-- ============================================
-- Performance Monitoring Queries
-- ============================================

-- Check slow queries (enable slow query log first)
-- SHOW VARIABLES LIKE 'slow_query_log';
-- SET GLOBAL slow_query_log = 'ON';
-- SET GLOBAL long_query_time = 2;  -- Log queries taking > 2 seconds

-- Check current connections
-- SHOW STATUS LIKE 'Threads_connected';

-- Check query cache hit rate (MySQL 5.7 and below)
-- SHOW STATUS LIKE 'Qcache%';

