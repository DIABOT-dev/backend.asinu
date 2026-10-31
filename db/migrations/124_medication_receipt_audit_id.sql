-- Encryption inventory/backfill pages by a globally unique scalar id. The
-- idempotency key remains (actor_id, request_id); a request UUID alone is not
-- unique across actors and must never identify another patient's audit row.
ALTER TABLE med_setup_receipts ADD COLUMN IF NOT EXISTS id BIGSERIAL;
ALTER TABLE med_setup_receipts ALTER COLUMN id SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS med_setup_receipt_audit_id ON med_setup_receipts(id);
