-- Idempotency table for in-app purchase receipts.
--
-- Apple delivers the same signedTransaction twice when their network
-- retries; Google Play Billing redelivers the purchase token after a
-- crash. We MUST de-duplicate or the user gets multiple Premium grants
-- for one payment.
--
-- Primary key is the platform transaction_id (Apple's transactionId
-- field; Google's orderId / purchaseToken). It's globally unique per
-- payment so we don't need to compose with platform.

CREATE TABLE IF NOT EXISTS iap_receipts (
  id                      BIGSERIAL PRIMARY KEY,
  user_id                 INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform                VARCHAR(16) NOT NULL CHECK (platform IN ('apple', 'google')),
  product_id              VARCHAR(80) NOT NULL,
  transaction_id          VARCHAR(128) NOT NULL UNIQUE,
  original_transaction_id VARCHAR(128),
  expires_at              TIMESTAMPTZ,
  raw_payload             JSONB,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_iap_receipts_user
  ON iap_receipts (user_id, created_at DESC);

-- Speeds up "find all transactions in a subscription" — Apple groups
-- renewals under the same original_transaction_id so this index lets us
-- pull the whole history of one Premium chain quickly.
CREATE INDEX IF NOT EXISTS idx_iap_receipts_original
  ON iap_receipts (original_transaction_id) WHERE original_transaction_id IS NOT NULL;
