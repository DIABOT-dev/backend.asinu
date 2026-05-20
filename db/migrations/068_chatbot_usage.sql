-- Daily/monthly chatbot usage tracking. Backs the rate limits enforced by
-- the chatbot feature flag (MVP audit FIX #1).
CREATE TABLE IF NOT EXISTS chatbot_usage (
  id            BIGSERIAL PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day_key       DATE    NOT NULL,                 -- usage date in UTC
  month_key     CHAR(7) NOT NULL,                 -- YYYY-MM, derived from day_key
  message_count INTEGER NOT NULL DEFAULT 0,
  tokens_used   INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, day_key)
);

CREATE INDEX IF NOT EXISTS idx_chatbot_usage_user_month ON chatbot_usage (user_id, month_key);
