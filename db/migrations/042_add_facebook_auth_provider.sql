-- Add FACEBOOK to auth_provider ENUM
-- migration 032 added facebook_id column but forgot to extend the ENUM
ALTER TYPE auth_provider ADD VALUE IF NOT EXISTS 'FACEBOOK';
