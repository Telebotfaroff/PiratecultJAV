-- Step 2: anti-abuse referral completion.
ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_completed BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS idx_users_referral_completed ON users(referral_completed);

CREATE OR REPLACE FUNCTION register_referral(p_referrer BIGINT,p_referred BIGINT)
RETURNS TABLE(success BOOLEAN,unlimited_until TIMESTAMPTZ)
LANGUAGE plpgsql AS $$
DECLARE referred_user users%ROWTYPE; referrer_user users%ROWTYPE;
BEGIN
 IF p_referrer IS NULL OR p_referred IS NULL OR p_referrer=p_referred THEN RETURN QUERY SELECT FALSE,NULL::TIMESTAMPTZ; RETURN; END IF;
 SELECT * INTO referrer_user FROM users WHERE telegram_user_id=p_referrer FOR UPDATE;
 IF NOT FOUND OR referrer_user.is_blocked THEN RETURN QUERY SELECT FALSE,NULL::TIMESTAMPTZ; RETURN; END IF;
 SELECT * INTO referred_user FROM users WHERE telegram_user_id=p_referred FOR UPDATE;
 IF NOT FOUND OR referred_user.referred_by IS NOT NULL OR referred_user.referral_completed THEN
  RETURN QUERY SELECT FALSE,referred_user.unlimited_until; RETURN;
 END IF;
 UPDATE users SET referred_by=p_referrer,updated_at=NOW() WHERE telegram_user_id=p_referred;
 RETURN QUERY SELECT TRUE,referrer_user.unlimited_until;
END; $$;

CREATE OR REPLACE FUNCTION complete_referral(p_referred BIGINT)
RETURNS TABLE(success BOOLEAN,unlimited_until TIMESTAMPTZ)
LANGUAGE plpgsql AS $$
DECLARE referred_user users%ROWTYPE; referrer_user users%ROWTYPE; base_time TIMESTAMPTZ; new_until TIMESTAMPTZ;
BEGIN
 SELECT * INTO referred_user FROM users WHERE telegram_user_id=p_referred FOR UPDATE;
 IF NOT FOUND OR referred_user.referred_by IS NULL OR referred_user.referral_completed THEN
  RETURN QUERY SELECT FALSE,NULL::TIMESTAMPTZ; RETURN;
 END IF;
 SELECT * INTO referrer_user FROM users WHERE telegram_user_id=referred_user.referred_by FOR UPDATE;
 IF NOT FOUND OR referrer_user.is_blocked THEN RETURN QUERY SELECT FALSE,NULL::TIMESTAMPTZ; RETURN; END IF;
 base_time:=GREATEST(COALESCE(referrer_user.unlimited_until,NOW()),NOW());
 new_until:=base_time+INTERVAL '1 day';
 UPDATE users SET unlimited_until=new_until,updated_at=NOW() WHERE telegram_user_id=referrer_user.telegram_user_id;
 UPDATE users SET referral_completed=TRUE,referral_reward_claimed=TRUE,updated_at=NOW() WHERE telegram_user_id=p_referred;
 RETURN QUERY SELECT TRUE,new_until;
END; $$;