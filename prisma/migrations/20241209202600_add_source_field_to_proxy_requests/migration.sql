-- AlterTable
ALTER TABLE `proxy_requests` ADD COLUMN `source` VARCHAR(191) NULL DEFAULT 'continuous';

-- CreateIndex
CREATE INDEX `proxy_requests_source_idx` ON `proxy_requests`(`source`);

