-- Thêm wallet_balance vào bảng users
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS wallet_balance NUMERIC(15, 2) NOT NULL DEFAULT 0;

-- Bảng thanh toán
CREATE TABLE IF NOT EXISTS payments (
  id          SERIAL PRIMARY KEY,
  order_code  VARCHAR(64) UNIQUE NOT NULL,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount      NUMERIC(15, 2) NOT NULL,
  qr_url      TEXT NOT NULL,
  status      VARCHAR(16) NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'completed', 'failed')),
  expires_at  TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '30 minutes'),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_payments_user_id   ON payments (user_id);
CREATE INDEX IF NOT EXISTS idx_payments_status     ON payments (status);
CREATE INDEX IF NOT EXISTS idx_payments_order_code ON payments (order_code);
