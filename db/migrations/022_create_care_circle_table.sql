-- Migration 022: Create care_circle table for guardian/carer relationships

CREATE TABLE IF NOT EXISTS care_circle (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  guardian_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT CHECK (status IN ('pending', 'active', 'inactive')) DEFAULT 'pending',
  relationship TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(patient_id, guardian_id)
);

CREATE INDEX IF NOT EXISTS idx_care_circle_patient_id ON care_circle(patient_id);
CREATE INDEX IF NOT EXISTS idx_care_circle_guardian_id ON care_circle(guardian_id);
CREATE INDEX IF NOT EXISTS idx_care_circle_status ON care_circle(status);

COMMENT ON TABLE care_circle IS 'Relationships between patients and their guardians/carers';
COMMENT ON COLUMN care_circle.patient_id IS 'User ID of the patient';
COMMENT ON COLUMN care_circle.guardian_id IS 'User ID of the guardian/carer';
COMMENT ON COLUMN care_circle.status IS 'Invitation status: pending, active, inactive';
COMMENT ON COLUMN care_circle.relationship IS 'Type of relationship (e.g., family, caregiver)';
