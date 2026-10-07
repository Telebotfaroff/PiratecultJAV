-- PiratecultJAV Force-Sub Request Mode
-- Adds per-channel support for Telegram join-request invite links.

ALTER TABLE force_sub_channels
  ADD COLUMN IF NOT EXISTS request_mode BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_force_sub_channels_active
  ON force_sub_channels (is_active);
