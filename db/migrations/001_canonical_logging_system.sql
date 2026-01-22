CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  phone VARCHAR(32) UNIQUE,
  email VARCHAR(255) UNIQUE,
  password_hash TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  deleted_at TIMESTAMP,
  token_version INTEGER DEFAULT 0
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS email VARCHAR(255) UNIQUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT;
ALTER TABLE users ALTER COLUMN phone DROP NOT NULL;

CREATE TABLE IF NOT EXISTS auth (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  provider VARCHAR(32),
  payload JSONB,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS logs (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  log_type VARCHAR(32),
  payload JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS logs_common (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id INTEGER REFERENCES users(id),
  log_type TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual',
  note TEXT,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS glucose_logs (
  log_id UUID PRIMARY KEY REFERENCES logs_common(id) ON DELETE CASCADE,
  value NUMERIC(10,2) NOT NULL,
  unit TEXT DEFAULT 'mg/dL',
  context TEXT,
  meal_tag TEXT
);

CREATE TABLE IF NOT EXISTS blood_pressure_logs (
  log_id UUID PRIMARY KEY REFERENCES logs_common(id) ON DELETE CASCADE,
  systolic INT NOT NULL,
  diastolic INT NOT NULL,
  pulse INT,
  unit TEXT DEFAULT 'mmHg'
);

CREATE TABLE IF NOT EXISTS weight_logs (
  log_id UUID PRIMARY KEY REFERENCES logs_common(id) ON DELETE CASCADE,
  weight_kg NUMERIC(6,2) NOT NULL,
  body_fat_percent NUMERIC(5,2),
  muscle_percent NUMERIC(5,2)
);

CREATE TABLE IF NOT EXISTS water_logs (
  log_id UUID PRIMARY KEY REFERENCES logs_common(id) ON DELETE CASCADE,
  volume_ml INT NOT NULL
);

CREATE TABLE IF NOT EXISTS meal_logs (
  log_id UUID PRIMARY KEY REFERENCES logs_common(id) ON DELETE CASCADE,
  calories_kcal INT,
  carbs_g NUMERIC(6,2),
  protein_g NUMERIC(6,2),
  fat_g NUMERIC(6,2),
  meal_text TEXT,
  photo_url TEXT
);

CREATE TABLE IF NOT EXISTS insulin_logs (
  log_id UUID PRIMARY KEY REFERENCES logs_common(id) ON DELETE CASCADE,
  insulin_type TEXT,
  dose_units NUMERIC(6,2) NOT NULL,
  unit VARCHAR(10) DEFAULT 'U',
  timing VARCHAR(20),
  injection_site TEXT
);

CREATE TABLE IF NOT EXISTS medication_logs (
  log_id UUID PRIMARY KEY REFERENCES logs_common(id) ON DELETE CASCADE,
  med_name TEXT NOT NULL,
  dose_text TEXT NOT NULL,
  dose_value NUMERIC(10,2),
  dose_unit TEXT,
  frequency_text TEXT
);

CREATE TABLE IF NOT EXISTS care_pulse_logs (
  log_id UUID PRIMARY KEY REFERENCES logs_common(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  sub_status TEXT,
  trigger_source TEXT NOT NULL,
  escalation_sent BOOLEAN DEFAULT FALSE,
  silence_count INT DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_logs_user_type_occurred ON logs_common(user_id, log_type, occurred_at DESC);
