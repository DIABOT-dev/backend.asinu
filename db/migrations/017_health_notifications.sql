-- Health monitoring notifications table
-- Stores in-app notifications for care circle health alerts

CREATE TABLE IF NOT EXISTS notifications (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type VARCHAR(50) NOT NULL DEFAULT 'general',
  title VARCHAR(255) NOT NULL,
  message TEXT NOT NULL,
  data JSONB DEFAULT '{}',
  is_read BOOLEAN DEFAULT false,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  read_at TIMESTAMP WITH TIME ZONE DEFAULT NULL
);

-- Index for efficient querying
CREATE INDEX IF NOT EXISTS idx_notifications_user_unread 
ON notifications(user_id, is_read, created_at DESC);

-- Index for notification type queries
CREATE INDEX IF NOT EXISTS idx_notifications_type 
ON notifications(type, created_at DESC);

-- Sample health alert notification types:
-- 'health_alert' - Cảnh báo sức khỏe từ health monitoring
-- 'care_circle_invitation' - Lời mời care circle  
-- 'care_circle_accepted' - Chấp nhận lời mời
-- 'mission_reminder' - Nhắc nhở nhiệm vụ
-- 'log_reminder' - Nhắc nhở ghi log

COMMENT ON TABLE notifications IS 'In-app notifications for users';
COMMENT ON COLUMN notifications.type IS 'Notification category: health_alert, care_circle_invitation, etc';
COMMENT ON COLUMN notifications.data IS 'Additional metadata for notification payload';
COMMENT ON COLUMN notifications.is_read IS 'Whether user has seen this notification';
COMMENT ON COLUMN notifications.read_at IS 'Timestamp when user marked as read';