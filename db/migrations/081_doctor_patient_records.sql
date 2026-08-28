-- Clinical records and files explicitly shared with the Doctor portal.
-- The Doctor integration never receives arbitrary user data: access is still
-- authorised by doctor_task_outbox before these rows are returned.
CREATE TABLE IF NOT EXISTS doctor_patient_medical_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  record_type TEXT NOT NULL DEFAULT 'consultation',
  title TEXT NOT NULL,
  diagnosis TEXT,
  summary TEXT,
  treatment TEXT,
  notes TEXT,
  doctor_ref TEXT,
  source_task_id TEXT,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS doctor_patient_medical_records_user_date_idx
  ON doctor_patient_medical_records(user_id, recorded_at DESC);

CREATE TABLE IF NOT EXISTS doctor_patient_files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
  secure_url TEXT NOT NULL,
  public_id TEXT,
  source_task_id TEXT,
  uploaded_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS doctor_patient_files_user_date_idx
  ON doctor_patient_files(user_id, created_at DESC);
