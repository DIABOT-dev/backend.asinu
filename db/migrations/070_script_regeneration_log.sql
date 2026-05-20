-- Track AI script regenerations per user/month so we can enforce the
-- monthly quota from the MVP audit (FIX #2). Each row = one AI generation.
CREATE TABLE IF NOT EXISTS script_regeneration_log (
  id          BIGSERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  cluster_key VARCHAR(80) NOT NULL,
  trigger     VARCHAR(32),                 -- 'new_symptom' | 'profile_change' | 'expired' | 'manual'
  month_key   CHAR(7) NOT NULL,            -- YYYY-MM
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_script_regen_user_month
  ON script_regeneration_log (user_id, month_key);
CREATE INDEX IF NOT EXISTS idx_script_regen_created
  ON script_regeneration_log (created_at DESC);
