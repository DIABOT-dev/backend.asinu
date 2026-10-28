-- Bind each supported native call channel to the exact registered push token.
-- A supported Android app must never enable calls to an older iOS device.
ALTER TABLE users ADD COLUMN IF NOT EXISTS doctor_ivr_fcm_hash TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS doctor_ivr_voip_hash TEXT;
