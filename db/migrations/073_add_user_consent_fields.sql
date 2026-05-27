-- Migration: Add user consent fields for Decree 13 compliance
ALTER TABLE users 
  ADD COLUMN IF NOT EXISTS consent_accepted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS consent_version VARCHAR(32);
