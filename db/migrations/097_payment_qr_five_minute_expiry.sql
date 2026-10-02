-- Payment QR codes are valid for at most five minutes. Shorten pending codes
-- that were created before this policy was introduced and align the table
-- default with the application service.

UPDATE payments
SET expires_at = LEAST(expires_at, created_at + INTERVAL '5 minutes')
WHERE status = 'pending';

ALTER TABLE payments
  ALTER COLUMN expires_at SET DEFAULT (NOW() + INTERVAL '5 minutes');
