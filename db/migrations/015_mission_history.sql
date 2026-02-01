-- Mission History Table
-- Tracks completed missions for stats and achievements

CREATE TABLE IF NOT EXISTS mission_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id INTEGER NOT NULL REFERENCES users(id),
  mission_key TEXT NOT NULL,
  completed_date DATE NOT NULL DEFAULT CURRENT_DATE,
  progress INTEGER NOT NULL DEFAULT 0,
  goal INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Index for efficient queries
CREATE INDEX IF NOT EXISTS idx_mission_history_user_date ON mission_history(user_id, completed_date DESC);
CREATE INDEX IF NOT EXISTS idx_mission_history_user_mission ON mission_history(user_id, mission_key, completed_date DESC);

-- Function to automatically save completed mission to history
CREATE OR REPLACE FUNCTION save_completed_mission_to_history()
RETURNS TRIGGER AS $$
BEGIN
  -- When a mission becomes completed, save to history
  IF NEW.status = 'completed' AND (OLD.status IS NULL OR OLD.status != 'completed') THEN
    INSERT INTO mission_history (user_id, mission_key, completed_date, progress, goal)
    VALUES (NEW.user_id, NEW.mission_key, CURRENT_DATE, NEW.progress, NEW.goal)
    ON CONFLICT DO NOTHING; -- Avoid duplicates if somehow triggered multiple times
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to auto-save completed missions
DROP TRIGGER IF EXISTS trigger_save_completed_mission ON user_missions;
CREATE TRIGGER trigger_save_completed_mission
  AFTER INSERT OR UPDATE ON user_missions
  FOR EACH ROW
  EXECUTE FUNCTION save_completed_mission_to_history();

-- Migrate existing completed missions to history
INSERT INTO mission_history (user_id, mission_key, completed_date, progress, goal, created_at)
SELECT 
  user_id, 
  mission_key, 
  COALESCE(last_incremented_date, CURRENT_DATE) as completed_date,
  progress,
  goal,
  updated_at
FROM user_missions
WHERE status = 'completed'
ON CONFLICT DO NOTHING;
