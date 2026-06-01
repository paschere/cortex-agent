CREATE OR REPLACE FUNCTION consume_rate_limit_token(
  p_user_id  uuid,
  p_tool_id  text,
  p_per_minute int
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_allowed boolean;
BEGIN
  INSERT INTO rate_limit_buckets (user_id, tool_id, tokens, refilled_at)
  VALUES (p_user_id, p_tool_id, p_per_minute - 1, now())
  ON CONFLICT (user_id, tool_id) DO UPDATE
    SET tokens = CASE
      WHEN rate_limit_buckets.refilled_at < now() - interval '1 minute'
        THEN p_per_minute - 1
      WHEN rate_limit_buckets.tokens > 0
        THEN rate_limit_buckets.tokens - 1
      ELSE rate_limit_buckets.tokens
    END,
    refilled_at = CASE
      WHEN rate_limit_buckets.refilled_at < now() - interval '1 minute'
        THEN now()
      ELSE rate_limit_buckets.refilled_at
    END;
  SELECT (tokens >= 0) INTO v_allowed
  FROM rate_limit_buckets
  WHERE user_id = p_user_id AND tool_id = p_tool_id;
  RETURN COALESCE(v_allowed, true);
END;
$$;
