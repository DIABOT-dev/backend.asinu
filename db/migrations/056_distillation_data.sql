-- 056: Distillation Data Collection
-- Thu thập Big Model outputs để cải thiện Small Model qua few-shot

CREATE TABLE IF NOT EXISTS distillation_data (
  id            SERIAL PRIMARY KEY,
  task_type     VARCHAR(50) NOT NULL,       -- 'triage', 'analysis', 'classification'
  model_used    VARCHAR(50) NOT NULL,       -- 'gpt-4o', 'gpt-4o-mini'
  input_hash    VARCHAR(32) NOT NULL,       -- MD5 hash of input messages
  input_data    JSONB NOT NULL,             -- messages array sent to AI
  output_data   JSONB NOT NULL,             -- AI response
  quality_score REAL,                       -- 0-1, null = unrated
  used_as_fewshot BOOLEAN DEFAULT FALSE,    -- đã dùng làm few-shot example chưa
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_distillation_task ON distillation_data(task_type);
CREATE INDEX IF NOT EXISTS idx_distillation_quality ON distillation_data(quality_score DESC NULLS LAST)
  WHERE quality_score IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_distillation_model ON distillation_data(model_used);
