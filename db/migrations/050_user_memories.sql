-- User AI Memory: lưu tóm tắt quan trọng về user qua các cuộc chat
-- Giống ChatGPT Memory - AI tự trích xuất điều cần nhớ

CREATE TABLE IF NOT EXISTS user_memories (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content TEXT NOT NULL,           -- nội dung memory (VD: "hay bị chóng mặt buổi sáng")
  category TEXT DEFAULT 'general', -- health, preference, concern, habit, medication
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_memories_user ON user_memories(user_id);
CREATE INDEX IF NOT EXISTS idx_user_memories_category ON user_memories(user_id, category);

-- Giới hạn tối đa 20 memories per user (xóa cũ nhất khi vượt)
