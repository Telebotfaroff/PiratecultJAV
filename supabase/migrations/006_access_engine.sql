-- Step 1: time-based access engine.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS plan_expires_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_users_plan_expires_at
  ON users(plan_expires_at);

CREATE OR REPLACE FUNCTION get_user_access(p_user_id BIGINT)
RETURNS TABLE(
  plan TEXT,
  plan_expires_at TIMESTAMPTZ,
  unlimited_until TIMESTAMPTZ,
  daily_limit INTEGER,
  daily_used INTEGER,
  daily_remaining INTEGER,
  is_unlimited BOOLEAN
)
LANGUAGE plpgsql
AS $$
DECLARE
  u users%ROWTYPE;
  effective_plan TEXT;
  limit_value INTEGER;
  unlimited BOOLEAN;
BEGIN
  SELECT * INTO u
  FROM users
  WHERE telegram_user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT
      'free'::TEXT, NULL::TIMESTAMPTZ, NULL::TIMESTAMPTZ,
      20, 0, 20, FALSE;
    RETURN;
  END IF;

  IF u.daily_download_date IS DISTINCT FROM CURRENT_DATE THEN
    UPDATE users
    SET daily_download_count = 0,
        daily_download_date = CURRENT_DATE,
        updated_at = NOW()
    WHERE telegram_user_id = p_user_id
    RETURNING * INTO u;
  END IF;

  effective_plan := CASE
    WHEN u.plan_expires_at IS NOT NULL
      AND u.plan_expires_at <= NOW()
      THEN 'free'
    ELSE u.plan
  END;

  limit_value := CASE
    WHEN effective_plan = 'semi_premium' THEN 40
    ELSE 20
  END;

  unlimited := effective_plan = 'premium'
    OR (
      u.unlimited_until IS NOT NULL
      AND u.unlimited_until > NOW()
    );

  RETURN QUERY SELECT
    effective_plan,
    CASE
      WHEN u.plan_expires_at IS NOT NULL
        AND u.plan_expires_at > NOW()
      THEN u.plan_expires_at
      ELSE NULL
    END,
    u.unlimited_until,
    CASE WHEN unlimited THEN -1 ELSE limit_value END,
    u.daily_download_count,
    CASE
      WHEN unlimited THEN -1
      ELSE GREATEST(limit_value - u.daily_download_count, 0)
    END,
    unlimited;
END;
$$;

CREATE OR REPLACE FUNCTION set_user_plan(
  p_user_id BIGINT,
  p_plan TEXT,
  p_duration_days INTEGER DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
BEGIN
  IF p_plan NOT IN ('free', 'semi_premium', 'premium') THEN
    RETURN FALSE;
  END IF;

  UPDATE users
  SET plan = p_plan,
      plan_expires_at = CASE
        WHEN p_duration_days IS NULL THEN NULL
        WHEN p_duration_days <= 0 THEN NOW()
        ELSE NOW() + make_interval(days => p_duration_days)
      END,
      updated_at = NOW()
  WHERE telegram_user_id = p_user_id;

  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION consume_video_download(p_user_id BIGINT)
RETURNS TABLE(
  allowed BOOLEAN,
  remaining INTEGER,
  plan TEXT,
  unlimited_until TIMESTAMPTZ
)
LANGUAGE plpgsql
AS $$
DECLARE
  u users%ROWTYPE;
  current_limit INTEGER;
  effective_plan TEXT;
  is_unlimited BOOLEAN := FALSE;
BEGIN
  SELECT * INTO u
  FROM users
  WHERE telegram_user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT
      FALSE, 0, 'free'::TEXT, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  IF u.daily_download_date IS DISTINCT FROM CURRENT_DATE THEN
    UPDATE users
    SET daily_download_count = 0,
        daily_download_date = CURRENT_DATE,
        updated_at = NOW()
    WHERE telegram_user_id = p_user_id
    RETURNING * INTO u;
  END IF;

  effective_plan := CASE
    WHEN u.plan_expires_at IS NOT NULL
      AND u.plan_expires_at <= NOW()
      THEN 'free'
    ELSE u.plan
  END;

  is_unlimited := effective_plan = 'premium'
    OR (
      u.unlimited_until IS NOT NULL
      AND u.unlimited_until > NOW()
    );

  IF is_unlimited THEN
    RETURN QUERY SELECT TRUE, -1, effective_plan, u.unlimited_until;
    RETURN;
  END IF;

  current_limit := CASE
    WHEN effective_plan = 'semi_premium' THEN 40
    ELSE 20
  END;

  IF u.daily_download_count >= current_limit THEN
    RETURN QUERY SELECT FALSE, 0, effective_plan, u.unlimited_until;
    RETURN;
  END IF;

  UPDATE users
  SET daily_download_count = daily_download_count + 1,
      updated_at = NOW()
  WHERE telegram_user_id = p_user_id
  RETURNING * INTO u;

  RETURN QUERY SELECT
    TRUE,
    GREATEST(current_limit - u.daily_download_count, 0),
    effective_plan,
    u.unlimited_until;
END;
$$;
