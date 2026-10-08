-- Step 6: Telegram Stars premium payments.
CREATE TABLE IF NOT EXISTS premium_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_user_id BIGINT NOT NULL REFERENCES users(telegram_user_id) ON DELETE CASCADE,
  payload TEXT NOT NULL,
  plan TEXT NOT NULL CHECK (plan = 'premium'),
  duration_days INTEGER NOT NULL CHECK (duration_days > 0),
  amount_stars INTEGER NOT NULL CHECK (amount_stars > 0),
  currency TEXT NOT NULL CHECK (currency = 'XTR'),
  telegram_payment_charge_id TEXT NOT NULL UNIQUE,
  provider_payment_charge_id TEXT,
  status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('completed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_premium_payments_user
  ON premium_payments(telegram_user_id, created_at DESC);

CREATE OR REPLACE FUNCTION complete_star_premium_payment(
  p_user_id BIGINT,
  p_payload TEXT,
  p_duration_days INTEGER,
  p_amount_stars INTEGER,
  p_currency TEXT,
  p_telegram_charge_id TEXT,
  p_provider_charge_id TEXT
)
RETURNS TABLE(success BOOLEAN, message TEXT, plan_expires_at TIMESTAMPTZ)
LANGUAGE plpgsql
AS $$
DECLARE
  u users%ROWTYPE;
  new_expiry TIMESTAMPTZ;
BEGIN
  IF p_currency <> 'XTR' OR p_duration_days <= 0 OR p_amount_stars <= 0
     OR p_telegram_charge_id IS NULL OR p_telegram_charge_id = '' THEN
    RETURN QUERY SELECT FALSE,'Invalid payment data.'::TEXT,NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1 FROM premium_payments
    WHERE telegram_payment_charge_id=p_telegram_charge_id
  ) THEN
    SELECT plan_expires_at INTO new_expiry FROM users WHERE telegram_user_id=p_user_id;
    RETURN QUERY SELECT TRUE,'Payment was already processed.'::TEXT,new_expiry;
    RETURN;
  END IF;

  SELECT * INTO u FROM users WHERE telegram_user_id=p_user_id FOR UPDATE;
  IF NOT FOUND OR u.is_blocked THEN
    RETURN QUERY SELECT FALSE,'Account is not eligible.'::TEXT,NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  new_expiry := GREATEST(
    COALESCE(
      CASE WHEN u.plan='premium' AND u.plan_expires_at > NOW()
           THEN u.plan_expires_at ELSE NOW() END,
      NOW()
    ),
    NOW()
  ) + make_interval(days=>p_duration_days);

  UPDATE users
    SET plan='premium',
        plan_expires_at=new_expiry,
        updated_at=NOW()
    WHERE telegram_user_id=p_user_id;

  INSERT INTO premium_payments(
    telegram_user_id,payload,plan,duration_days,amount_stars,currency,
    telegram_payment_charge_id,provider_payment_charge_id
  ) VALUES (
    p_user_id,p_payload,'premium',p_duration_days,p_amount_stars,p_currency,
    p_telegram_charge_id,p_provider_charge_id
  );

  RETURN QUERY SELECT TRUE,'Premium activated successfully.'::TEXT,new_expiry;
END;
$$;