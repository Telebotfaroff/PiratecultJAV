-- Step 5: promo codes.
CREATE TABLE IF NOT EXISTS promo_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE,
  reward_type TEXT NOT NULL CHECK (reward_type IN ('plan','unlimited')),
  reward_plan TEXT CHECK (reward_plan IN ('semi_premium','premium')),
  reward_days INTEGER NOT NULL CHECK (reward_days > 0),
  max_uses INTEGER,
  used_count INTEGER NOT NULL DEFAULT 0 CHECK (used_count >= 0),
  expires_at TIMESTAMPTZ,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (reward_type = 'plan' AND reward_plan IS NOT NULL)
    OR
    (reward_type = 'unlimited' AND reward_plan IS NULL)
  ),
  CHECK (max_uses IS NULL OR max_uses > 0)
);

CREATE TABLE IF NOT EXISTS promo_redemptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  promo_id UUID NOT NULL REFERENCES promo_codes(id) ON DELETE CASCADE,
  telegram_user_id BIGINT NOT NULL REFERENCES users(telegram_user_id) ON DELETE CASCADE,
  redeemed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(promo_id, telegram_user_id)
);

CREATE INDEX IF NOT EXISTS idx_promo_codes_active ON promo_codes(is_active, expires_at);
CREATE INDEX IF NOT EXISTS idx_promo_redemptions_user ON promo_redemptions(telegram_user_id);

CREATE OR REPLACE FUNCTION create_promo_code(
  p_code TEXT,
  p_reward_type TEXT,
  p_reward_plan TEXT,
  p_reward_days INTEGER,
  p_max_uses INTEGER DEFAULT NULL,
  p_expires_at TIMESTAMPTZ DEFAULT NULL,
  p_created_by BIGINT DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
AS $$
DECLARE promo_id UUID;
BEGIN
  IF p_reward_type NOT IN ('plan','unlimited')
     OR p_reward_days <= 0
     OR (p_reward_type='plan' AND p_reward_plan NOT IN ('semi_premium','premium'))
     OR (p_reward_type='unlimited' AND p_reward_plan IS NOT NULL)
     OR (p_max_uses IS NOT NULL AND p_max_uses <= 0) THEN
    RETURN NULL;
  END IF;

  INSERT INTO promo_codes(code,reward_type,reward_plan,reward_days,max_uses,expires_at,created_by)
  VALUES (UPPER(TRIM(p_code)),p_reward_type,p_reward_plan,p_reward_days,p_max_uses,p_expires_at,p_created_by)
  RETURNING id INTO promo_id;

  RETURN promo_id;
EXCEPTION WHEN unique_violation THEN
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION redeem_promo_code(
  p_user_id BIGINT,
  p_code TEXT
)
RETURNS TABLE(
  success BOOLEAN,
  message TEXT,
  reward_type TEXT,
  reward_plan TEXT,
  reward_days INTEGER,
  expires_at TIMESTAMPTZ
)
LANGUAGE plpgsql
AS $$
DECLARE promo promo_codes%ROWTYPE;
DECLARE u users%ROWTYPE;
DECLARE new_expiry TIMESTAMPTZ;
BEGIN
  SELECT * INTO u FROM users WHERE telegram_user_id=p_user_id FOR UPDATE;
  IF NOT FOUND OR u.is_blocked THEN
    RETURN QUERY SELECT FALSE,'Account is not eligible.'::TEXT,NULL::TEXT,NULL::TEXT,0,NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  SELECT * INTO promo FROM promo_codes WHERE code=UPPER(TRIM(p_code)) AND is_active=TRUE FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT FALSE,'Invalid or inactive promo code.'::TEXT,NULL::TEXT,NULL::TEXT,0,NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  IF promo.expires_at IS NOT NULL AND promo.expires_at <= NOW() THEN
    RETURN QUERY SELECT FALSE,'This promo code has expired.'::TEXT,promo.reward_type,promo.reward_plan,promo.reward_days,promo.expires_at;
    RETURN;
  END IF;

  IF promo.max_uses IS NOT NULL AND promo.used_count >= promo.max_uses THEN
    RETURN QUERY SELECT FALSE,'This promo code has reached its usage limit.'::TEXT,promo.reward_type,promo.reward_plan,promo.reward_days,promo.expires_at;
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1 FROM promo_redemptions
    WHERE promo_id=promo.id AND telegram_user_id=p_user_id
  ) THEN
    RETURN QUERY SELECT FALSE,'You have already redeemed this promo code.'::TEXT,promo.reward_type,promo.reward_plan,promo.reward_days,promo.expires_at;
    RETURN;
  END IF;

  IF promo.reward_type='plan' THEN
    new_expiry := GREATEST(COALESCE(u.plan_expires_at,NOW()),NOW()) + make_interval(days=>promo.reward_days);
    UPDATE users
      SET plan=promo.reward_plan,
          plan_expires_at=new_expiry,
          updated_at=NOW()
      WHERE telegram_user_id=p_user_id;
  ELSE
    new_expiry := GREATEST(COALESCE(u.unlimited_until,NOW()),NOW()) + make_interval(days=>promo.reward_days);
    UPDATE users
      SET unlimited_until=new_expiry,
          updated_at=NOW()
      WHERE telegram_user_id=p_user_id;
  END IF;

  INSERT INTO promo_redemptions(promo_id,telegram_user_id) VALUES (promo.id,p_user_id);
  UPDATE promo_codes SET used_count=used_count+1 WHERE id=promo.id;

  RETURN QUERY SELECT TRUE,'Promo redeemed successfully.'::TEXT,promo.reward_type,promo.reward_plan,promo.reward_days,new_expiry;
END;
$$;