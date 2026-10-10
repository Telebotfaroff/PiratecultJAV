-- ============================================================================
-- PiratecultJAV Database Schema Migration (001_initial_schema.sql)
-- Target: Supabase PostgreSQL
-- ============================================================================

-- 1. Enable UUID Extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 2. Users Table
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    telegram_user_id BIGINT UNIQUE NOT NULL,
    username TEXT,
    first_name TEXT,
    last_name TEXT,
    is_blocked BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_telegram_user_id ON users (telegram_user_id);

-- 3. Videos Table
-- Status values: pending, available, failed, disabled
CREATE TABLE IF NOT EXISTS videos (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    code TEXT NOT NULL,
    normalized_code TEXT UNIQUE NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    provider TEXT DEFAULT 'javtiful',
    thumbnail_file_id TEXT,
    thumbnail_message_id BIGINT,
    dump_chat_id TEXT NOT NULL,
    video_message_id BIGINT NOT NULL,
    status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('pending', 'available', 'failed', 'disabled')),
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_videos_normalized_code ON videos (normalized_code);
CREATE INDEX IF NOT EXISTS idx_videos_code ON videos (code);
CREATE INDEX IF NOT EXISTS idx_videos_status ON videos (status);
CREATE INDEX IF NOT EXISTS idx_videos_created_at ON videos (created_at DESC);

-- 4. Index Jobs Table
-- Unique on (dump_chat_id, video_message_id) to strictly prevent duplicate processing
CREATE TABLE IF NOT EXISTS index_jobs (
    id BIGSERIAL PRIMARY KEY,
    code TEXT NOT NULL,
    dump_chat_id TEXT NOT NULL,
    video_message_id BIGINT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'processing', 'completed', 'failed')),
    attempts INT DEFAULT 0,
    error TEXT,
    next_attempt_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT uq_dump_video UNIQUE (dump_chat_id, video_message_id)
);

CREATE INDEX IF NOT EXISTS idx_index_jobs_status ON index_jobs (status, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_index_jobs_code ON index_jobs (code);
CREATE INDEX IF NOT EXISTS idx_index_jobs_next_attempt ON index_jobs (next_attempt_at) WHERE status = 'queued';

-- Backwards-compatible upgrade for databases created before retry scheduling was added.
ALTER TABLE index_jobs ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ;

-- 5. Admin Sessions Table
CREATE TABLE IF NOT EXISTS admin_sessions (
    telegram_user_id BIGINT PRIMARY KEY,
    state TEXT NOT NULL,
    code TEXT,
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 6. Force-Sub Channels Table
CREATE TABLE IF NOT EXISTS force_sub_channels (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    channel_id TEXT UNIQUE NOT NULL,
    -- Legacy compatibility alias retained for older deployed databases.
    chat_id TEXT,
    title TEXT NOT NULL,
    invite_link TEXT,
    request_mode BOOLEAN NOT NULL DEFAULT FALSE,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 7. Force-Sub Admin Sessions Table
CREATE TABLE IF NOT EXISTS force_sub_admin_sessions (
    telegram_user_id BIGINT PRIMARY KEY,
    state TEXT NOT NULL,
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 8. Bot Settings Table
CREATE TABLE IF NOT EXISTS bot_settings (
    key TEXT PRIMARY KEY,
    value JSONB NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Seed default bot settings
INSERT INTO bot_settings (key, value)
VALUES 
    ('force_sub_enabled', 'false'::jsonb),
    ('maintenance_mode', 'false'::jsonb),
    ('search_page_size', '5'::jsonb),
    ('rate_limit_per_minute', '20'::jsonb),
    ('delete_timer_seconds', '0'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- 9. Admin Actions (Audit Trail)
CREATE TABLE IF NOT EXISTS admin_actions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    admin_id BIGINT NOT NULL,
    action TEXT NOT NULL,
    payload JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_actions_admin_id ON admin_actions (admin_id);

-- 10. Atomic Safe Job Claiming Function
-- Concurrency safe: Uses FOR UPDATE SKIP LOCKED
CREATE OR REPLACE FUNCTION claim_next_index_job()
RETURNS SETOF index_jobs
LANGUAGE plpgsql
AS $$
DECLARE
    claimed_record index_jobs%ROWTYPE;
BEGIN
    SELECT *
    INTO claimed_record
    FROM index_jobs
    WHERE status = 'queued'
      AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())
    ORDER BY id ASC
    FOR UPDATE SKIP LOCKED
    LIMIT 1;

    IF FOUND THEN
        UPDATE index_jobs
        SET status = 'processing',
            next_attempt_at = NULL,
            attempts = attempts + 1,
            updated_at = NOW()
        WHERE id = claimed_record.id
        RETURNING * INTO claimed_record;

        RETURN NEXT claimed_record;
    END IF;

    RETURN;
END;
$$;
