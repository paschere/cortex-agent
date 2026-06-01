ALTER TABLE conversations ADD COLUMN IF NOT EXISTS pinned boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS conversations_user_pinned_idx ON conversations(user_id, pinned, updated_at DESC);
