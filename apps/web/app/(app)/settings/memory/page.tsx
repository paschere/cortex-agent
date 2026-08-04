import { toMemoryView } from '@/app/api/settings/memories/schema';
import { PageHeader } from '@/components/ui/page-header';
import { requireSession } from '@/lib/session';
import { getSupabaseServiceClient } from '@/lib/supabase/service';
import { listMemories } from '@cortex/agent-tools';
import { Brain } from 'lucide-react';
import { MemoryList } from './MemoryList';

export const dynamic = 'force-dynamic';

/**
 * /settings/memory — everything Cortex has learned about this person, in the
 * sentences it actually uses.
 *
 * Its own page rather than a panel on /settings because the list is long-lived
 * and acted on (accept, reject, delete), while /settings is a form you fill in
 * and save. And it exists at all because a system that remembers things about
 * you which you cannot see or remove is not one anybody should be asked to
 * trust: what it holds, where each thing came from, when it was last useful,
 * and a way to delete it — all in one place.
 *
 * `listMemories` derives the set from the session's user id inside Postgres;
 * there is no id in the URL and no way to point this page at anyone else.
 */
export default async function MemoryPage() {
  const user = await requireSession();
  const db = getSupabaseServiceClient();
  const memories = (await listMemories(db, user.id)).map(toMemoryView);

  return (
    <>
      <PageHeader
        title="Lo que Cortex recuerda"
        subtitle="Todo lo que Cortex ha aprendido de cómo trabajas: visible, editable y tuyo para borrar"
        icon={<Brain className="h-5 w-5" />}
      />
      <MemoryList initial={memories} />
    </>
  );
}
