-- PiratecultJAV security/performance indexes and constraints
-- Apply after the existing schema migrations.

CREATE INDEX IF NOT EXISTS idx_videos_provider_status_created
  ON videos (provider, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_videos_status_created
  ON videos (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_users_blocked_created
  ON users (is_blocked, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_index_jobs_status_next_attempt
  ON index_jobs (status, next_attempt_at, id);

CREATE INDEX IF NOT EXISTS idx_force_sub_active
  ON force_sub_channels (is_active, created_at ASC);

-- Normalize duplicate code variants at the database boundary.
CREATE UNIQUE INDEX IF NOT EXISTS uq_videos_normalized_code
  ON videos (normalized_code);
