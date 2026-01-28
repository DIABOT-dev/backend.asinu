CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS user_onboarding_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id INTEGER UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  age TEXT CHECK (age IN ('30-39', '40-49', '50-59', '60+')),
  gender TEXT CHECK (gender IN ('Nam', 'Nữ')),
  goal TEXT CHECK (goal IN ('Giảm đau', 'Tăng linh hoạt', 'Tăng sức mạnh', 'Cải thiện vận động')),
  body_type TEXT CHECK (body_type IN ('Gầy', 'Cân đối', 'Thừa cân')),
  medical_conditions JSONB NOT NULL DEFAULT '[]'::jsonb,
  chronic_symptoms JSONB NOT NULL DEFAULT '[]'::jsonb,
  joint_issues JSONB NOT NULL DEFAULT '[]'::jsonb,
  flexibility TEXT,
  stairs_performance TEXT,
  exercise_freq TEXT,
  walking_habit TEXT,
  water_intake TEXT,
  sleep_duration TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS user_onboarding_profiles_user_id_key
  ON user_onboarding_profiles (user_id);

CREATE INDEX IF NOT EXISTS user_onboarding_profiles_user_id_idx
  ON user_onboarding_profiles (user_id);
