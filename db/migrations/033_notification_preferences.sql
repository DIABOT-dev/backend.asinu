-- 033_notification_preferences.sql
-- Per-user notification schedule preferences.
-- morning_hour / evening_hour / water_hour = null → use auto-inferred value.
-- inferred_* = learned from user's actual log timestamps (last 60 days).

CREATE TABLE IF NOT EXISTS user_notification_preferences (
  user_id               INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,

  -- User-set hours (null = auto)
  morning_hour          SMALLINT CHECK (morning_hour  BETWEEN 5 AND 11),
  evening_hour          SMALLINT CHECK (evening_hour  BETWEEN 17 AND 23),
  water_hour            SMALLINT CHECK (water_hour    BETWEEN 10 AND 18),

  -- Auto-inferred from log history (refreshed when stale or on demand)
  inferred_morning_hour SMALLINT,
  inferred_evening_hour SMALLINT,
  inferred_water_hour   SMALLINT,
  inferred_at           TIMESTAMPTZ,

  updated_at            TIMESTAMPTZ DEFAULT NOW()
);
