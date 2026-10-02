-- Preserve every completed/replaced check-in when a user records another
-- health update during the same Vietnam health day.

ALTER TABLE health_checkins
  ADD COLUMN IF NOT EXISTS occurrence_source TEXT,
  ADD COLUMN IF NOT EXISTS occurrence_started_at TIMESTAMPTZ;

UPDATE health_checkins
SET occurrence_source = COALESCE(occurrence_source, 'scheduled'),
    occurrence_started_at = COALESCE(occurrence_started_at, created_at, updated_at, NOW())
WHERE occurrence_source IS NULL OR occurrence_started_at IS NULL;

ALTER TABLE health_checkins
  ALTER COLUMN occurrence_source SET DEFAULT 'scheduled',
  ALTER COLUMN occurrence_source SET NOT NULL,
  ALTER COLUMN occurrence_started_at SET DEFAULT NOW(),
  ALTER COLUMN occurrence_started_at SET NOT NULL;

CREATE TABLE IF NOT EXISTS health_checkin_occurrences (
  id                    BIGSERIAL PRIMARY KEY,
  checkin_id            BIGINT REFERENCES health_checkins(id) ON DELETE CASCADE,
  user_id               INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_date          DATE NOT NULL,
  source                TEXT NOT NULL DEFAULT 'instant',
  initial_status        TEXT NOT NULL,
  current_status        TEXT NOT NULL,
  flow_state            TEXT NOT NULL,
  body_locations        TEXT[],
  body_location_other   TEXT,
  triage_messages       JSONB NOT NULL DEFAULT '[]'::jsonb,
  triage_summary        TEXT,
  triage_severity       TEXT,
  family_alerted        BOOLEAN NOT NULL DEFAULT FALSE,
  emergency_triggered   BOOLEAN NOT NULL DEFAULT FALSE,
  started_at            TIMESTAMPTZ NOT NULL,
  completed_at          TIMESTAMPTZ,
  snapshot_updated_at   TIMESTAMPTZ NOT NULL,
  archived_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_health_checkin_occurrence_snapshot
  ON health_checkin_occurrences(checkin_id, snapshot_updated_at);

CREATE INDEX IF NOT EXISTS idx_health_checkin_occurrences_user_date
  ON health_checkin_occurrences(user_id, session_date DESC, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_health_checkin_occurrences_checkin
  ON health_checkin_occurrences(checkin_id);

CREATE OR REPLACE FUNCTION reject_health_checkin_occurrence_update()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'health check-in occurrence snapshots are immutable';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_health_checkin_occurrence_no_update ON health_checkin_occurrences;
CREATE TRIGGER trg_health_checkin_occurrence_no_update
BEFORE UPDATE ON health_checkin_occurrences
FOR EACH ROW EXECUTE FUNCTION reject_health_checkin_occurrence_update();

COMMENT ON TABLE health_checkin_occurrences IS
  'Immutable snapshots of earlier check-in occurrences replaced by another instant check-in on the same health day.';
