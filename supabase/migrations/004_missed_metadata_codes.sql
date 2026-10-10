-- Store codes whose provider metadata lookup failed so admins can complete them manually.
CREATE TABLE IF NOT EXISTS missed_metadata_codes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  code TEXT NOT NULL,
  normalized_code TEXT NOT NULL UNIQUE,
  failure_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_missed_metadata_codes_created_at
  ON missed_metadata_codes (created_at DESC);

ALTER TABLE missed_metadata_codes ENABLE ROW LEVEL SECURITY;

-- This table is accessed by the bot using the Supabase service role key.
-- No public policies are intentionally created.
