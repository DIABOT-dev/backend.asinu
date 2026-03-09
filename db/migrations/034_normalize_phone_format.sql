-- Migration 034: Normalize phone numbers from +84xxx to 0xxx format
-- Converts all existing +84xxxxxxxxx entries to 0xxxxxxxxx

UPDATE users
SET phone_number = '0' || SUBSTRING(phone_number FROM 4)
WHERE phone_number LIKE '+84%'
  AND LENGTH(phone_number) >= 12;

-- Verify
-- SELECT id, phone_number FROM users WHERE phone_number LIKE '+84%';
