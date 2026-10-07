-- Referral system and video download plans
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS plan TEXT NOT NULL DEFAULT 'free'
    CHECK (plan IN ('free', 'semi_premium', 'premium')),
  ADD COLUMN IF NOT EXISTS daily_download_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS daily_download_date DATE NOT NULL DEFAULT CURRENT_DATE,
  ADD COLUMN IF NOT EXISTS unlimited_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS referred_by BIGINT REFERENCES users(telegram_user_id),
  ADD COLUMN IF NOT EXISTS referral_reward_claimed BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_users_plan ON users(plan);
CREATE INDEX IF NOT EXISTS idx_users_referred_by ON users(referred_by);

-- Atomically consume one video allowance. This prevents double-spending when
-- a user taps multiple Get buttons at the same time.
CREATE OR REPLACE FUNCTION consume_video_download(p_user_id BIGINT)
RETURNS TABLE(allowed BOOLEAN, remaining INTEGER, plan TEXT, unlimited_until TIMESTAMPTZ)
LANGUAGE plpgsql
AS $$
DECLARE
  u users%ROWTYPE;
  current_limit INTEGER;
  is_unlimited BOOLEAN := FALSE;
BEGIN
  SELECT * INTO u FROM users WHERE telegram_user_id = p_user_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT FALSE, 0, 'free'::TEXT, NULL::TIMESTAMPTZ;
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

  is_unlimited := u.plan = 'premium'
                  OR (u.unlimited_until IS NOT NULL AND u.unlimited_until > NOW());

  IF is_unlimited THEN
    RETURN QUERY SELECT TRUE, -1, u.plan, u.unlimited_until;
    RETURN;
  END IF;

  current_limit := CASE
    WHEN u.plan = 'semi_premium' THEN 40
    ELSE 20
  END;

  IF u.daily_download_count >= current_limit THEN
    RETURN QUERY SELECT FALSE, 0, u.plan, u.unlimited_until;
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
    u.plan,
    u.unlimited_until;
END;
$$;

-- A referral is successful only once per referred Telegram account.
-- The referrer receives one additional day of unlimited access.
CREATE OR REPLACE FUNCTION register_referral(p_referrer BIGINT, p_referred BIGINT)
RETURNS TABLE(success BOOLEAN, unlimited_until TIMESTAMPTZ)
LANGUAGE plpgsql
AS $$
DECLARE
  referred_user users%ROWTYPE;
  referrer_user users%ROWTYPE;
  base_time TIMESTAMPTZ;
  new_until TIMESTAMPTZ;
BEGIN
  IF p_referrer IS NULL OR p_referred IS NULL OR p_referrer = p_referred THEN
    RETURN QUERY SELECT FALSE, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  SELECT * INTO referrer_user FROM users
    WHERE telegram_user_id = p_referrer FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT FALSE, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  SELECT * INTO referred_user FROM users
    WHERE telegram_user_id = p_referred FOR UPDATE;
  IF NOT FOUND OR referred_user.referred_by IS NOT NULL THEN
    RETURN QUERY SELECT FALSE, referred_user.unlimited_until;
    RETURN;
  END IF;

  base_time := GREATEST(COALESCE(referrer_user.unlimited_until, NOW()), NOW());
  new_until := base_time + INTERVAL '1 day';

  UPDATE users
    SET referred_by = p_referrer,
        referral_reward_claimed = TRUE,
        unlimited_until = new_until,
        updated_at = NOW()
    WHERE telegram_user_id = p_referrer;

  UPDATE users
    SET referred_by = p_referrer,
        updated_at = NOW()
    WHERE telegram_user_id = p_referred;

  RETURN QUERY SELECT TRUE, new_until;
END;
$$;

CREATE OR REPLACE FUNCTION set_user_plan(p_user_id BIGINT, p_plan TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
BEGIN
  IF p_plan NOT IN ('free', 'semi_premium', 'premium') THEN
    RETURN FALSE;
  END IF;

  UPDATE users
    SET plan = p_plan,
        updated_at = NOW()
    WHERE telegram_user_id = p_user_id;

  RETURN FOUND;
END;
$$;
