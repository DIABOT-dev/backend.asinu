-- Track the payer separately from the subscription recipient.
-- Lets Tùng (payer) buy Premium for Đức (recipient_user_id) from his
-- own Care Circle. user_id is still the BENEFICIARY so existing queries
-- (filter by user_id → who has premium) keep working without rewrites.
ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS payer_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS is_gift       BOOLEAN NOT NULL DEFAULT FALSE;

-- Backfill: every existing subscription was self-paid.
UPDATE subscriptions
   SET payer_user_id = user_id
 WHERE payer_user_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_subscriptions_payer ON subscriptions (payer_user_id);
