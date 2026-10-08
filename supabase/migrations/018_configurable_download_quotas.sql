-- Configurable daily download quotas.
-- Admins store the limits in bot_settings.download_quotas as {free, semi_premium}.
INSERT INTO bot_settings(key, value, updated_at)
VALUES ('download_quotas', '{"free":20,"semi_premium":40}'::jsonb, NOW())
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION consume_video_download(p_user_id BIGINT)
RETURNS TABLE(allowed BOOLEAN,remaining INTEGER,plan TEXT,unlimited_until TIMESTAMPTZ)
LANGUAGE plpgsql AS $$
DECLARE
  u users%ROWTYPE;
  lim INTEGER;
  ep TEXT;
  unlim BOOLEAN;
  free_lim INTEGER := 20;
  semi_lim INTEGER := 40;
  quota_value JSONB;
BEGIN
  SELECT value INTO quota_value
  FROM bot_settings
  WHERE key='download_quotas'
  LIMIT 1;

  IF quota_value IS NOT NULL THEN
    IF (quota_value->>'free') ~ '^[0-9]+$' THEN
      free_lim := LEAST((quota_value->>'free')::INTEGER, 100000);
    END IF;
    IF (quota_value->>'semi_premium') ~ '^[0-9]+$' THEN
      semi_lim := LEAST((quota_value->>'semi_premium')::INTEGER, 100000);
    END IF;
  END IF;

  SELECT * INTO u FROM users WHERE telegram_user_id=p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT FALSE,0,'free'::TEXT,NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  IF u.daily_download_date IS DISTINCT FROM CURRENT_DATE THEN
    UPDATE users
    SET daily_download_count=0,daily_download_date=CURRENT_DATE,updated_at=NOW()
    WHERE telegram_user_id=p_user_id
    RETURNING * INTO u;
  END IF;

  ep:=CASE WHEN u.plan_expires_at IS NOT NULL AND u.plan_expires_at<=NOW() THEN 'free' ELSE u.plan END;
  unlim:=ep='premium' OR (u.unlimited_until IS NOT NULL AND u.unlimited_until>NOW());

  IF unlim THEN
    RETURN QUERY SELECT TRUE,-1,ep,u.unlimited_until;
    RETURN;
  END IF;

  lim:=CASE WHEN ep='semi_premium' THEN semi_lim ELSE free_lim END;

  IF u.daily_download_count>=lim THEN
    RETURN QUERY SELECT FALSE,0,ep,u.unlimited_until;
    RETURN;
  END IF;

  UPDATE users
  SET daily_download_count=daily_download_count+1,updated_at=NOW()
  WHERE telegram_user_id=p_user_id
  RETURNING * INTO u;

  RETURN QUERY SELECT TRUE,GREATEST(lim-u.daily_download_count,0),ep,u.unlimited_until;
END $$;
