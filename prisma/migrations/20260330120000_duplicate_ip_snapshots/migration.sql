-- Duplicate IP snapshot tables (final denormalized shape: captured_at + proxy_status_scope on each row;
-- no duplicate_ip_snapshot_runs). Replaces 20260328120000 + 20260329120000 for greenfield / single prod deploy.

CREATE TABLE `duplicate_ip_snapshot_rows` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `captured_at` DATETIME(3) NOT NULL,
    `proxy_status_scope` VARCHAR(16) NOT NULL,
    `last_ip` VARCHAR(45) NOT NULL,
    `location` TEXT NULL,
    `all_servers_on_ip` TEXT NULL,
    `phones_on_same_ip` INTEGER NOT NULL,
    `sibling_phones` TEXT NULL,
    `device_ids` TEXT NULL,
    PRIMARY KEY (`id`),
    UNIQUE INDEX `duplicate_ip_snapshot_rows_captured_at_proxy_status_scope_last_ip_key`(`captured_at`, `proxy_status_scope`, `last_ip`),
    INDEX `duplicate_ip_snapshot_rows_captured_at_proxy_status_scope_idx`(`captured_at`, `proxy_status_scope`),
    INDEX `duplicate_ip_snapshot_rows_last_ip_captured_at_idx`(`last_ip`, `captured_at`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `duplicate_ip_snapshot_servers` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `captured_at` DATETIME(3) NOT NULL,
    `proxy_status_scope` VARCHAR(16) NOT NULL,
    `last_ip` VARCHAR(45) NOT NULL,
    `server_label` VARCHAR(64) NOT NULL,
    PRIMARY KEY (`id`),
    UNIQUE INDEX `duplicate_ip_snapshot_servers_cap_scope_ip_srv_key`(`captured_at`, `proxy_status_scope`, `last_ip`, `server_label`),
    INDEX `duplicate_ip_snapshot_servers_captured_at_proxy_status_scope_idx`(`captured_at`, `proxy_status_scope`),
    INDEX `duplicate_ip_snapshot_servers_last_ip_captured_at_idx`(`last_ip`, `captured_at`),
    INDEX `duplicate_ip_snapshot_servers_server_label_captured_at_idx`(`server_label`, `captured_at`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
