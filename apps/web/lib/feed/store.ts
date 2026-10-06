import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { FeedDetail } from './shared';

export { FEED_COLUMNS } from '@cortex/agent-tools/src/table-sync/feed-capture';
import { FEED_COLUMNS } from '@cortex/agent-tools/src/table-sync/feed-capture';

/** The client pins the organization; Feed additionally belongs to its uploader. */
export function ownedFeed(db: SupabaseClient, userId: string, columns = FEED_COLUMNS) {
  return db
    .from('chat_attachments')
    .select<string, FeedDetail & { file_path: string | null }>(columns)
    .eq('created_by', userId)
    .not('feed_kind', 'is', null)
    .gt('purge_at', new Date().toISOString());
}
