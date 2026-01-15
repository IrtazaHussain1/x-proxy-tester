-- Migration: Add 'version' field to proxies table
-- 
-- This migration adds the 'version' field extracted from the 'extra' field.
-- The 'extra' field contains base64 encoded JSON that may include a 'version' field.
-- This migration extracts and stores that version for easier querying.

-- Add version column
ALTER TABLE proxies
ADD COLUMN IF NOT EXISTS version VARCHAR(50) NULL COMMENT 'Version extracted from extra.version field';

-- Note: Existing records will have NULL values for this field
-- The sync logic will populate this field on next device refresh
-- You can backfill existing records by running the sync script:
-- npx tsx scripts/sync-device-fields-from-api.ts
