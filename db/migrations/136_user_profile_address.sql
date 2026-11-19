-- Profile addresses belong to the authenticated user and are not clinical data.
ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_address JSONB;
ALTER TABLE users ADD CONSTRAINT users_profile_address_object
  CHECK (profile_address IS NULL OR jsonb_typeof(profile_address) = 'object');
