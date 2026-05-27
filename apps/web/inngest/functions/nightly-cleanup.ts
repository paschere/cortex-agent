import { inngest } from '@/lib/inngest';
import { getSupabaseServiceClient } from '@/lib/supabase/service';

// Runs nightly at 03:00 UTC. Deletes conversation-scoped KB collections
// that were created more than 24 hours ago. Cascades to kb_documents and kb_chunks.
export const nightlyCleanup = inngest.createFunction(
  { id: 'nightly-kb-cleanup' },
  { cron: '0 3 * * *' },
  async ({ step }) => {
    const deleted = await step.run('delete-stale-conversation-collections', async () => {
      const sb = getSupabaseServiceClient();
      const { data, error } = await sb
        .from('kb_collections')
        .delete()
        .eq('scope', 'conversation')
        .lt('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
        .select('id');
      if (error) throw new Error(`Cleanup failed: ${error.message}`);
      return data?.length ?? 0;
    });

    return { ok: true, deleted };
  },
);
