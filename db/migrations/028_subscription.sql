-- Migration 028: Subscription / Premium Tier

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS subscription_tier VARCHAR(16) NOT NULL DEFAULT 'free',
  ADD COLUMN IF NOT EXISTS subscription_expires_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS subscriptions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  order_code VARCHAR(64) UNIQUE NOT NULL,
  amount NUMERIC(15, 2) NOT NULL,
  qr_url TEXT NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'pending',
  plan_months INTEGER NOT NULL DEFAULT 1,
  subscription_start TIMESTAMPTZ,
  subscription_end TIMESTAMPTZ,
  qr_expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '30 minutes'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_user_id ON subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_order_code ON subscriptions(order_code);
