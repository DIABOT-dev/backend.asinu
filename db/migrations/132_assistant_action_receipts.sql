-- Mutation receipts contain only a capability fingerprint, never chat/health content.
CREATE TABLE assistant_action_receipts (
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request_id UUID NOT NULL,
  fingerprint TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (owner_id, request_id)
);
