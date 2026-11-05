-- Unconfirmed medication setup is private draft data, never an active schedule.
CREATE TABLE med_setup_drafts (
 id UUID PRIMARY KEY,
 actor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 patient_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
 state TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(state IN ('ACTIVE','DELETED','SAVED')),
 snapshot_json TEXT,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX med_setup_drafts_active ON med_setup_drafts(actor_id,patient_user_id) WHERE state='ACTIVE';
