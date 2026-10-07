-- A shared drive has a changes feed separate from the user's My Drive feed.
-- Keep both cursors for a linked Knowledge collection.
alter table public.gdrive_sync_state
  add column drive_id text,
  add column drive_page_token text,
  add column last_error text,
  add column last_completed_at timestamptz;
