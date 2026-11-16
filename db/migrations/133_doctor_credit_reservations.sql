CREATE TABLE doctor_consultation_credit_reservations (
  task_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  household_id BIGINT REFERENCES subscription_households(id) ON DELETE CASCADE,
  grant_reference TEXT,
  state TEXT NOT NULL CHECK (state IN ('none','reserved','consumed','released')),
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  settled_at TIMESTAMPTZ,
  CHECK ((state='none' AND household_id IS NULL) OR (state<>'none' AND household_id IS NOT NULL))
);
CREATE INDEX doctor_credit_held_idx ON doctor_consultation_credit_reservations(household_id) WHERE state='reserved';
CREATE UNIQUE INDEX doctor_credit_person_grant_idx ON doctor_consultation_credit_reservations(user_id,grant_reference)
  WHERE state IN ('reserved','consumed');
