CREATE TABLE IF NOT EXISTS iap_transaction_revocations (
  platform TEXT NOT NULL CHECK (platform IN ('apple', 'google')),
  transaction_id TEXT NOT NULL,
  original_transaction_id TEXT,
  product_id TEXT,
  reason TEXT NOT NULL CHECK (reason IN ('refund', 'revoke')),
  revoked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (platform, transaction_id)
);

-- Preserve known refunds from before transaction-level revocation tracking.
-- Only block the affected transaction, never future renewals in the same chain.
INSERT INTO iap_transaction_revocations
  (platform, transaction_id, original_transaction_id, product_id, reason)
SELECT r.platform, r.transaction_id, r.original_transaction_id, r.product_id,
       CASE WHEN h.status = 'refunded' THEN 'refund' ELSE 'revoke' END
FROM subscription_households h
JOIN LATERAL (
  SELECT * FROM iap_receipts receipt
  WHERE receipt.user_id = h.owner_user_id
    AND receipt.platform = h.platform
    AND receipt.product_id = h.product_id
    AND (receipt.original_transaction_id = h.original_transaction_id
         OR receipt.transaction_id = h.original_transaction_id)
  ORDER BY receipt.expires_at DESC NULLS LAST, receipt.id DESC LIMIT 1
) r ON TRUE
WHERE h.status IN ('refunded', 'revoked')
ON CONFLICT (platform, transaction_id) DO NOTHING;
