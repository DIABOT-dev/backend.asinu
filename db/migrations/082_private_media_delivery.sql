ALTER TABLE doctor_patient_files
  ADD COLUMN IF NOT EXISTS resource_type TEXT NOT NULL DEFAULT 'raw',
  ADD COLUMN IF NOT EXISTS delivery_type TEXT NOT NULL DEFAULT 'legacy_public';
