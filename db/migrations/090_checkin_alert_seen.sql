-- `seen` only records that a caregiver viewed an alert. It must not close it.
ALTER TABLE caregiver_alert_confirmations
  ADD COLUMN IF NOT EXISTS seen_at TIMESTAMPTZ;
