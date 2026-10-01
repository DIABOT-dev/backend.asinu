-- Asinu V2: household entitlements, protected members and Early Signals.
-- Legacy users.subscription_tier is retained during the transition so older
-- mobile builds keep working. New code reads subscription_households.

CREATE TABLE IF NOT EXISTS subscription_households (
  id BIGSERIAL PRIMARY KEY,
  owner_user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  plan_code TEXT NOT NULL DEFAULT 'free'
    CHECK (plan_code IN ('free', 'antam_2', 'antam_4', 'antam_8')),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'grace_period', 'expired', 'refunded', 'revoked')),
  billing_period TEXT CHECK (billing_period IN ('monthly', 'yearly')),
  protected_member_limit INTEGER NOT NULL DEFAULT 1
    CHECK (protected_member_limit IN (1, 2, 4, 8)),
  platform TEXT CHECK (platform IN ('apple', 'google', 'legacy')),
  product_id TEXT,
  original_transaction_id TEXT,
  current_period_start TIMESTAMPTZ,
  current_period_end TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_subscription_households_active
  ON subscription_households (plan_code, current_period_end)
  WHERE status IN ('active', 'grace_period');

CREATE INDEX IF NOT EXISTS idx_subscription_households_transaction
  ON subscription_households (original_transaction_id)
  WHERE original_transaction_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS subscription_household_members (
  id BIGSERIAL PRIMARY KEY,
  household_id BIGINT NOT NULL REFERENCES subscription_households(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'removed')),
  added_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  removed_at TIMESTAMPTZ,
  UNIQUE (household_id, user_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_active_protected_household_per_user
  ON subscription_household_members (user_id)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_subscription_household_members_active
  ON subscription_household_members (household_id, added_at)
  WHERE status = 'active';

CREATE TABLE IF NOT EXISTS consultation_credit_ledger (
  id BIGSERIAL PRIMARY KEY,
  household_id BIGINT NOT NULL REFERENCES subscription_households(id) ON DELETE CASCADE,
  delta INTEGER NOT NULL CHECK (delta <> 0),
  reason TEXT NOT NULL CHECK (reason IN ('annual_grant', 'consultation_used', 'manual_adjustment', 'refund')),
  reference_id TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (reason, reference_id)
);

ALTER TABLE iap_receipts
  ADD COLUMN IF NOT EXISTS plan_code TEXT,
  ADD COLUMN IF NOT EXISTS billing_period TEXT,
  ADD COLUMN IF NOT EXISTS base_plan_id TEXT,
  ADD COLUMN IF NOT EXISTS offer_id TEXT;

ALTER TABLE checkin_call_episodes
  ADD COLUMN IF NOT EXISTS trigger_source TEXT NOT NULL DEFAULT 'MISSED_CHECKIN',
  ADD COLUMN IF NOT EXISTS early_signal_assessment_id BIGINT;

ALTER TABLE checkin_call_episodes
  DROP CONSTRAINT IF EXISTS checkin_call_episodes_user_id_local_date_key;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_daily_checkin_call_episode
  ON checkin_call_episodes (user_id, local_date)
  WHERE trigger_source = 'MISSED_CHECKIN';
CREATE UNIQUE INDEX IF NOT EXISTS uniq_early_signal_call_episode
  ON checkin_call_episodes (early_signal_assessment_id)
  WHERE early_signal_assessment_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS early_signal_assessments (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  requested_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  trigger_type TEXT NOT NULL
    CHECK (trigger_type IN ('manual', 'weekly', 'new_log', 'worsened')),
  trigger_ref TEXT,
  window_start DATE NOT NULL,
  window_end DATE NOT NULL,
  input_snapshot JSONB NOT NULL,
  severity TEXT NOT NULL
    CHECK (severity IN ('monitor', 'see_doctor', 'urgent')),
  is_red_flag BOOLEAN NOT NULL DEFAULT FALSE,
  signals JSONB NOT NULL DEFAULT '[]'::jsonb,
  summary TEXT NOT NULL,
  suggested_specialty TEXT,
  urgent_signs JSONB NOT NULL DEFAULT '[]'::jsonb,
  disclaimer TEXT NOT NULL,
  output_snapshot JSONB NOT NULL,
  audit_hash TEXT NOT NULL,
  family_notified_at TIMESTAMPTZ,
  call_episode_id UUID REFERENCES checkin_call_episodes(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE checkin_call_episodes
  DROP CONSTRAINT IF EXISTS checkin_call_episodes_early_signal_assessment_id_fkey;
ALTER TABLE checkin_call_episodes
  ADD CONSTRAINT checkin_call_episodes_early_signal_assessment_id_fkey
  FOREIGN KEY (early_signal_assessment_id)
  REFERENCES early_signal_assessments(id) ON DELETE SET NULL
  DEFERRABLE INITIALLY DEFERRED;

CREATE INDEX IF NOT EXISTS idx_early_signal_user_created
  ON early_signal_assessments (user_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_early_signal_trigger_ref
  ON early_signal_assessments (user_id, trigger_type, trigger_ref)
  WHERE trigger_ref IS NOT NULL;

CREATE OR REPLACE FUNCTION protect_early_signal_evidence()
RETURNS trigger AS $$
BEGIN
  IF NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.requested_by IS DISTINCT FROM OLD.requested_by
     OR NEW.trigger_type IS DISTINCT FROM OLD.trigger_type
     OR NEW.trigger_ref IS DISTINCT FROM OLD.trigger_ref
     OR NEW.window_start IS DISTINCT FROM OLD.window_start
     OR NEW.window_end IS DISTINCT FROM OLD.window_end
     OR NEW.input_snapshot IS DISTINCT FROM OLD.input_snapshot
     OR NEW.severity IS DISTINCT FROM OLD.severity
     OR NEW.is_red_flag IS DISTINCT FROM OLD.is_red_flag
     OR NEW.signals IS DISTINCT FROM OLD.signals
     OR NEW.summary IS DISTINCT FROM OLD.summary
     OR NEW.suggested_specialty IS DISTINCT FROM OLD.suggested_specialty
     OR NEW.urgent_signs IS DISTINCT FROM OLD.urgent_signs
     OR NEW.disclaimer IS DISTINCT FROM OLD.disclaimer
     OR NEW.output_snapshot IS DISTINCT FROM OLD.output_snapshot
     OR NEW.audit_hash IS DISTINCT FROM OLD.audit_hash
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'early signal clinical evidence is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_early_signal_no_update ON early_signal_assessments;
CREATE TRIGGER trg_early_signal_no_update
BEFORE UPDATE ON early_signal_assessments
FOR EACH ROW EXECUTE FUNCTION protect_early_signal_evidence();

-- Backfill a household for every existing account. Active Premium users move
-- to An Tam 2 with the same expiration date; everyone else starts on Free.
INSERT INTO subscription_households (
  owner_user_id,
  plan_code,
  status,
  billing_period,
  protected_member_limit,
  platform,
  current_period_start,
  current_period_end
)
SELECT
  u.id,
  CASE
    WHEN u.subscription_tier = 'premium' AND u.subscription_expires_at > NOW()
      THEN 'antam_2'
    ELSE 'free'
  END,
  'active',
  CASE
    WHEN u.subscription_tier = 'premium' AND u.subscription_expires_at > NOW()
      THEN 'monthly'
    ELSE NULL
  END,
  CASE
    WHEN u.subscription_tier = 'premium' AND u.subscription_expires_at > NOW()
      THEN 2
    ELSE 1
  END,
  CASE
    WHEN u.subscription_tier = 'premium' AND u.subscription_expires_at > NOW()
      THEN 'legacy'
    ELSE NULL
  END,
  CASE
    WHEN u.subscription_tier = 'premium' AND u.subscription_expires_at > NOW()
      THEN COALESCE(u.created_at, NOW())
    ELSE NULL
  END,
  CASE
    WHEN u.subscription_tier = 'premium' AND u.subscription_expires_at > NOW()
      THEN u.subscription_expires_at
    ELSE NULL
  END
FROM users u
ON CONFLICT (owner_user_id) DO NOTHING;

INSERT INTO subscription_household_members (household_id, user_id, added_by)
SELECT h.id, h.owner_user_id, h.owner_user_id
FROM subscription_households h
ON CONFLICT (household_id, user_id) DO NOTHING;

CREATE OR REPLACE FUNCTION create_default_subscription_household()
RETURNS trigger AS $$
DECLARE
  new_household_id BIGINT;
BEGIN
  INSERT INTO subscription_households (owner_user_id)
  VALUES (NEW.id)
  ON CONFLICT (owner_user_id) DO UPDATE SET owner_user_id = EXCLUDED.owner_user_id
  RETURNING id INTO new_household_id;

  INSERT INTO subscription_household_members (household_id, user_id, added_by)
  VALUES (new_household_id, NEW.id, NEW.id)
  ON CONFLICT (household_id, user_id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_users_default_subscription_household ON users;
CREATE TRIGGER trg_users_default_subscription_household
AFTER INSERT ON users
FOR EACH ROW EXECUTE FUNCTION create_default_subscription_household();

-- V2 keeps the complete chat history for every account.
CREATE OR REPLACE FUNCTION cleanup_chat_histories() RETURNS void AS $$
BEGIN
  RETURN;
END;
$$ LANGUAGE plpgsql;
