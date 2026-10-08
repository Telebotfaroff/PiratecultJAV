-- Harden promo code input and reward bounds.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='promo_codes_code_length_check') THEN
    ALTER TABLE promo_codes ADD CONSTRAINT promo_codes_code_length_check CHECK (char_length(code) BETWEEN 3 AND 64);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='promo_codes_reward_days_check') THEN
    ALTER TABLE promo_codes ADD CONSTRAINT promo_codes_reward_days_check CHECK (reward_days BETWEEN 1 AND 3650);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION create_promo_code(
  p_code TEXT,
  p_reward_type TEXT,
  p_reward_plan TEXT,
  p_reward_days INTEGER,
  p_max_uses INTEGER DEFAULT NULL,
  p_expires_at TIMESTAMPTZ DEFAULT NULL,
  p_created_by BIGINT DEFAULT NULL
)
RETURNS UUID LANGUAGE plpgsql AS $$
DECLARE pid UUID; normalized_code TEXT;
BEGIN
 normalized_code:=UPPER(TRIM(p_code));
 IF char_length(normalized_code) NOT BETWEEN 3 AND 64
    OR normalized_code !~ '^[A-Z0-9_-]+$'
    OR p_reward_days NOT BETWEEN 1 AND 3650
    OR (p_max_uses IS NOT NULL AND p_max_uses<=0)
    OR p_reward_type NOT IN('plan','unlimited')
    OR (p_reward_type='plan' AND p_reward_plan NOT IN('semi_premium','premium'))
    OR (p_reward_type='unlimited' AND p_reward_plan IS NOT NULL)
 THEN RETURN NULL; END IF;
 INSERT INTO promo_codes(code,reward_type,reward_plan,reward_days,max_uses,expires_at,created_by)
 VALUES(normalized_code,p_reward_type,p_reward_plan,p_reward_days,p_max_uses,p_expires_at,p_created_by)
 RETURNING id INTO pid;
 RETURN pid;
EXCEPTION WHEN unique_violation THEN RETURN NULL;
END $$;