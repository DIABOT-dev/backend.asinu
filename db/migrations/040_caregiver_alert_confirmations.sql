-- Tracks each caregiver alert sent, and whether the caregiver confirmed receipt
CREATE TABLE IF NOT EXISTS caregiver_alert_confirmations (
  id              BIGSERIAL PRIMARY KEY,
  checkin_id      BIGINT       REFERENCES health_checkins(id) ON DELETE CASCADE,
  caregiver_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  patient_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  alert_type      TEXT NOT NULL DEFAULT 'caregiver_alert', -- 'caregiver_alert' | 'emergency'
  sent_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  confirmed_at    TIMESTAMPTZ,
  confirmed_action TEXT,        -- 'seen' | 'on_my_way' | 'called'
  resent_count    INTEGER NOT NULL DEFAULT 0,
  resent_at       TIMESTAMPTZ,
  UNIQUE (checkin_id, caregiver_id)
);

CREATE INDEX IF NOT EXISTS idx_cac_caregiver   ON caregiver_alert_confirmations(caregiver_id);
CREATE INDEX IF NOT EXISTS idx_cac_unconfirmed ON caregiver_alert_confirmations(confirmed_at) WHERE confirmed_at IS NULL;
