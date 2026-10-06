-- The existing permission belongs to the requester. The addressee must
-- explicitly grant access to their own health profile, never inherit consent.
ALTER TABLE user_connections
  ADD COLUMN IF NOT EXISTS addressee_can_view_logs BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN user_connections.addressee_can_view_logs IS
  'Consent from the addressee for the requester to view their health profile while connected';
