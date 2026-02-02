-- Migration: Add 'extra' field to proxies table
-- 
-- This migration adds the 'extra' field from XProxy API to store base64 encoded JSON data
-- The field is synced from the API dashboard to keep local DB in sync

-- Add extra column
ALTER TABLE proxies
ADD COLUMN IF NOT EXISTS extra TEXT NULL COMMENT 'Base64 encoded JSON from XProxy API';

-- Note: Existing records will have NULL values for this field
-- The sync logic will populate this field on next device refresh
