-- ============================================================================
-- PiratecultJAV Database Schema Migration (004_delete_timer.sql)
-- ============================================================================

INSERT INTO bot_settings (key, value)
VALUES ('delete_timer_seconds', '0'::jsonb)
ON CONFLICT (key) DO NOTHING;