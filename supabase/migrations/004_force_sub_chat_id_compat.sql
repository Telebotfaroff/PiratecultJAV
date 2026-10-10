-- Force-sub schema compatibility for databases that retain the legacy chat_id column.
-- The application writes both channel_id and chat_id while this compatibility column exists.
ALTER TABLE force_sub_channels
  ADD COLUMN IF NOT EXISTS chat_id TEXT;

-- Backfill old rows when chat_id was newly added or previously left empty.
UPDATE force_sub_channels
SET chat_id = channel_id
WHERE chat_id IS NULL;
