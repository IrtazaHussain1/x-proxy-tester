-- Migration: Add 'ws_status_before' and 'ws_status_after' fields to ip_rotations table
-- 
-- This migration adds WebSocket status tracking before and after rotation commands.
-- This helps track the connection state of devices during IP rotation.

-- Add ws_status_before column
ALTER TABLE ip_rotations
ADD COLUMN IF NOT EXISTS ws_status_before VARCHAR(50) NULL COMMENT 'WebSocket status before rotation command';

-- Add ws_status_after column
ALTER TABLE ip_rotations
ADD COLUMN IF NOT EXISTS ws_status_after VARCHAR(50) NULL COMMENT 'WebSocket status after rotation (from verification)';

-- Note: Existing records will have NULL values for these fields
-- The sync logic will populate these fields on next rotation cycle
