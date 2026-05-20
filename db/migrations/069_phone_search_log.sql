-- Per-user rate limit ledger for phone search.
-- One row per (user, day) — counter is incremented on each search.
CREATE TABLE IF NOT EXISTS phone_search_log (
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day_key      DATE    NOT NULL,
  search_count INTEGER NOT NULL DEFAULT 0,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, day_key)
);

CREATE INDEX IF NOT EXISTS idx_phone_search_log_day ON phone_search_log (day_key);
