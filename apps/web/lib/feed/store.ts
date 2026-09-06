import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { FeedDetail } from './shared';

export const FEED_COLUMNS =
  'id, filename, feed_kind, source_url, created_at, purge_at, byte_size, conversation_id, promoted_document_id, feed_truncated';

/** The client pins the organization; Feed additionally belongs to its uploader. */
export function ownedFeed(db: SupabaseClient, userId: string, columns = FEED_COLUMNS) {
  return db
    .from('chat_attachments')
    .select<string, FeedDetail & { file_path: string | null }>(columns)
    .eq('created_by', userId)
    .not('feed_kind', 'is', null)
    .gt('purge_at', new Date().toISOString());
}
