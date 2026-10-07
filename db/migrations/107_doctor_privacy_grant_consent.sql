ALTER TABLE doctor_privacy_request_receipts
  DROP CONSTRAINT IF EXISTS doctor_privacy_request_receipts_action_check;

ALTER TABLE doctor_privacy_request_receipts
  ADD CONSTRAINT doctor_privacy_request_receipts_action_check
  CHECK (action IN ('grant_consent', 'withdraw_consent', 'export', 'anonymize', 'delete'));
