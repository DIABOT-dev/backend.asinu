-- Health-feed articles remain available until the user dismisses them.
-- Keep the response field for older clients, but stop assigning expiry dates.
ALTER TABLE health_feed_feed_items
  ALTER COLUMN expires_at DROP NOT NULL,
  ALTER COLUMN expires_at DROP DEFAULT;

-- Restore previously expired items without changing read/dismissal history,
-- creating new feed items, or re-queuing notifications.
UPDATE health_feed_feed_items
SET expires_at = NULL
WHERE expires_at IS NOT NULL;
