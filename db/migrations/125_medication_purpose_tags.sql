-- Confirmed purpose tags and provenance are private medication data.
ALTER TABLE med_items ADD COLUMN tags_json TEXT;
