-- Each unfinished setup has its own identity; starting another never discards it.
DROP INDEX med_setup_drafts_active;
CREATE INDEX med_setup_drafts_active
 ON med_setup_drafts(actor_id,patient_user_id,updated_at DESC,id DESC)
 WHERE state='ACTIVE';
