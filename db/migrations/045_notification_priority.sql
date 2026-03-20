-- Add priority column to notifications
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS priority VARCHAR(10) DEFAULT 'low';

-- Backfill existing notifications
UPDATE notifications SET priority = 'critical' WHERE type IN ('emergency');
UPDATE notifications SET priority = 'high' WHERE type IN ('health_alert', 'caregiver_alert', 'checkin_followup');
UPDATE notifications SET priority = 'medium' WHERE type IN ('morning_checkin', 'care_circle_invitation', 'reminder_glucose', 'reminder_bp');
