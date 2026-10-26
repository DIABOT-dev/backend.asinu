ALTER TABLE doctor_ivr_templates ADD COLUMN IF NOT EXISTS source_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS doctor_ivr_templates_source ON doctor_ivr_templates(source_user_id);
