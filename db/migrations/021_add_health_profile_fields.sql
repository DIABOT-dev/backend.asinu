-- Migration 021: Add specific health metrics to user_onboarding_profiles
-- Bổ sung các chỉ số sức khỏe cụ thể

ALTER TABLE user_onboarding_profiles 
ADD COLUMN IF NOT EXISTS date_of_birth DATE;

ALTER TABLE user_onboarding_profiles
ADD COLUMN IF NOT EXISTS height_cm NUMERIC(5,2);

ALTER TABLE user_onboarding_profiles
ADD COLUMN IF NOT EXISTS weight_kg NUMERIC(6,2);

ALTER TABLE user_onboarding_profiles
ADD COLUMN IF NOT EXISTS blood_type TEXT CHECK (blood_type IN ('A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'));

COMMENT ON COLUMN user_onboarding_profiles.date_of_birth IS 'User exact date of birth';
COMMENT ON COLUMN user_onboarding_profiles.height_cm IS 'User height in centimeters';
COMMENT ON COLUMN user_onboarding_profiles.weight_kg IS 'User current weight in kilograms';
COMMENT ON COLUMN user_onboarding_profiles.blood_type IS 'User blood type (A+, A-, B+, B-, AB+, AB-, O+, O-)';
