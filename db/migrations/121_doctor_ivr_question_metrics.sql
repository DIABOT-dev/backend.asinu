-- Non-reversible, tenant-scoped question fingerprints support aggregate quality
-- metrics without storing clinical question text in analytics columns.
ALTER TABLE doctor_ivr_answers ADD COLUMN IF NOT EXISTS question_fingerprint TEXT;
CREATE INDEX IF NOT EXISTS doctor_ivr_question_metrics ON doctor_ivr_answers(question_fingerprint)
 WHERE active AND question_fingerprint IS NOT NULL;
