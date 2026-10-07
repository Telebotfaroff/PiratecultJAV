-- PiratecultJAV retry/recovery upgrade
-- Run this once on an existing Supabase database.

ALTER TABLE index_jobs
  ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_index_jobs_next_attempt
  ON index_jobs (next_attempt_at)
  WHERE status = 'queued';

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
