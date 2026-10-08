-- Harden referral completion locking so concurrent referral operations use one lock order.
CREATE OR REPLACE FUNCTION complete_referral(p_referred BIGINT)
RETURNS TABLE(success BOOLEAN,unlimited_until TIMESTAMPTZ)
LANGUAGE plpgsql AS $$
DECLARE
  ru users%ROWTYPE;
  rr users%ROWTYPE;
  base_time TIMESTAMPTZ;
  nu TIMESTAMPTZ;
  referrer_id BIGINT;
BEGIN
  -- Read only to discover the referrer, then lock referrer first.
  SELECT referred_by INTO referrer_id
  FROM users
  WHERE telegram_user_id=p_referred;

  IF referrer_id IS NULL THEN
    RETURN QUERY SELECT FALSE,NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  SELECT * INTO rr
  FROM users
  WHERE telegram_user_id=referrer_id
  FOR UPDATE;

  IF NOT FOUND OR rr.is_blocked THEN
    RETURN QUERY SELECT FALSE,NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  -- Lock referred user second, matching register_referral's lock order.
  SELECT * INTO ru
  FROM users
  WHERE telegram_user_id=p_referred
  FOR UPDATE;

  IF NOT FOUND OR ru.referred_by IS NULL OR ru.referred_by<>referrer_id OR ru.referral_completed THEN
    RETURN QUERY SELECT FALSE,NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  base_time:=GREATEST(COALESCE(rr.unlimited_until,NOW()),NOW());
  nu:=base_time+INTERVAL '1 day';

  UPDATE users
  SET unlimited_until=nu,updated_at=NOW()
  WHERE telegram_user_id=rr.telegram_user_id;

  UPDATE users
  SET referral_completed=TRUE,referral_reward_claimed=TRUE,updated_at=NOW()
  WHERE telegram_user_id=ru.telegram_user_id;

  RETURN QUERY SELECT TRUE,nu;
END $$;