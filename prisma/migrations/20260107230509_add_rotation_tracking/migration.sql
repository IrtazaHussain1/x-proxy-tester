-- CreateTable
CREATE TABLE `rotation_cycles` (
    `id` VARCHAR(36) NOT NULL,
    `cycle_type` VARCHAR(50) NOT NULL,
    `cycle_timestamp` DATETIME(3) NOT NULL,
    `total_proxies` INTEGER NOT NULL DEFAULT 0,
    `successful_count` INTEGER NOT NULL DEFAULT 0,
    `failed_count` INTEGER NOT NULL DEFAULT 0,
    `pending_count` INTEGER NOT NULL DEFAULT 0,
    `status` VARCHAR(50) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `idx_rotation_cycles_cycle_timestamp` (`cycle_timestamp`),
    INDEX `idx_rotation_cycles_status` (`status`),
    INDEX `idx_rotation_cycles_cycle_type` (`cycle_type`),
    INDEX `idx_rotation_cycles_cycle_type_timestamp` (`cycle_type`, `cycle_timestamp`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ip_rotations` (
    `id` VARCHAR(36) NOT NULL,
    `cycle_id` VARCHAR(36) NOT NULL,
    `proxy_id` VARCHAR(255) NOT NULL,
    `rotation_timestamp` DATETIME(3) NOT NULL,
    `rotation_type` VARCHAR(50) NOT NULL,
    `command_sent_at` DATETIME(3) NOT NULL,
    `command_response` JSON NULL,
    `ip_before` VARCHAR(45) NULL,
    `ip_after` VARCHAR(45) NULL,
    `status_before` VARCHAR(50) NULL,
    `status_after` VARCHAR(50) NULL,
    `success` BOOLEAN NOT NULL DEFAULT false,
    `verification_method` VARCHAR(50) NULL,
    `verified_at` DATETIME(3) NULL,
    `wait_time_ms` INTEGER NULL,
    `rotation_duration_ms` INTEGER NULL,
    `retry_count` INTEGER NOT NULL DEFAULT 0,
    `error_message` TEXT NULL,
    `device_metadata` JSON NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `idx_ip_rotations_cycle_id` (`cycle_id`),
    INDEX `idx_ip_rotations_proxy_id` (`proxy_id`),
    INDEX `idx_ip_rotations_rotation_timestamp` (`rotation_timestamp`),
    INDEX `idx_ip_rotations_success` (`success`),
    INDEX `idx_ip_rotations_cycle_timestamp` (`cycle_id`, `rotation_timestamp`),
    INDEX `idx_ip_rotations_proxy_timestamp` (`proxy_id`, `rotation_timestamp`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `ip_rotations` ADD CONSTRAINT `ip_rotations_cycle_id_fkey` FOREIGN KEY (`cycle_id`) REFERENCES `rotation_cycles`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ip_rotations` ADD CONSTRAINT `ip_rotations_proxy_id_fkey` FOREIGN KEY (`proxy_id`) REFERENCES `proxies`(`device_id`) ON DELETE CASCADE ON UPDATE CASCADE;

