-- Keep historical wellness alerts when a Care Circle connection is removed.
ALTER TABLE caregiver_alerts
  DROP CONSTRAINT IF EXISTS caregiver_alerts_connection_id_fkey;

ALTER TABLE caregiver_alerts
  ADD CONSTRAINT caregiver_alerts_connection_id_fkey
  FOREIGN KEY (connection_id) REFERENCES user_connections(id) ON DELETE SET NULL;
