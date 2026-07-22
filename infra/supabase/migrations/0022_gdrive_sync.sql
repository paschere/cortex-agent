-- Google Drive sync: per-collection ownership + tracked folders, and
-- document revision tracking for change detection.
--
-- gdrive_sync_state (added in 0003_kb.sql) holds one row per KB collection
-- synced from Drive. We add:
--   - owner_user_id: the user whose Drive OAuth credentials drive the sync.
--     ON DELETE SET NULL so removing a user doesn't drop the sync row; the
--     sync simply becomes orphaned until re-owned.
--   - tracked_folder_ids: the Drive folder ids this collection mirrors.
--     Defaults to an empty array so existing rows remain valid.
--
-- kb_documents (added in 0003_kb.sql) gains:
--   - source_revision: the Drive file revision/version id last ingested,
--     used to skip re-ingesting unchanged files on incremental sync.

alter table public.gdrive_sync_state
  add column owner_user_id uuid references public.users(id) on delete set null,
  add column tracked_folder_ids text[] not null default '{}';

alter table public.kb_documents
  add column source_revision text;
