import { loadEvents, loadRun, loadTasks } from '@/lib/orchestrator/repository';
import { requireSession } from '@/lib/session';
import { getSupabaseServiceClient } from '@/lib/supabase/service';
import { notFound } from 'next/navigation';
import { Console } from './_components/Console';

export const dynamic = 'force-dynamic';

/**
 * How much of the log is rendered on the server. A long run with eight tool-happy
 * sub-agents can pass this, in which case the console shows the oldest window
 * and resumes from its end — the tail is what matters while a run is live, and
 * the whole point of the cursor is that nothing is lost either way.
 */
const EVENT_WINDOW = 2000;

export default async function OrchestratorRunPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requireSession();
  const { id } = await params;
  const db = getSupabaseServiceClient();

  // Scoped to the active workspace, so a run id from another tenant is a 404
  // rather than a leak.
  const run = await loadRun(db, id, user.organization.id);
  if (!run) notFound();

  const [tasks, events] = await Promise.all([
    loadTasks(db, id),
    loadEvents(db, id, 0, EVENT_WINDOW),
  ]);

  return <Console run={run} tasks={tasks} events={events} />;
}
