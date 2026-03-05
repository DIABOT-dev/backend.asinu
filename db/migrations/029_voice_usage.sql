-- 029_voice_usage.sql
-- Theo dõi lượt sử dụng voice chat theo tháng của từng user

CREATE TABLE IF NOT EXISTS voice_usage (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  year_month  CHAR(7) NOT NULL,          -- format: '2026-03'
  count       INTEGER NOT NULL DEFAULT 0,
  UNIQUE(user_id, year_month)
);

CREATE INDEX IF NOT EXISTS idx_voice_usage_user_month ON voice_usage(user_id, year_month);
