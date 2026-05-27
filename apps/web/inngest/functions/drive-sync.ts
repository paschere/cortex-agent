import { inngest } from '@/lib/inngest';

// TODO: Implement Google Drive incremental sync.
// This cron runs every 10 minutes and processes gdrive_sync_state for all
// kb_collections that have a gdrive_folder_id set. For MVP, this is a no-op.
export const driveSync = inngest.createFunction(
  { id: 'drive-sync-all' },
  { cron: '*/10 * * * *' },
  async () => {
    // TODO: iterate kb_collections with gdrive_folder_id set,
    // use Drive Changes API to incrementally sync documents.
    return { ok: true, synced: 0 };
  },
);
