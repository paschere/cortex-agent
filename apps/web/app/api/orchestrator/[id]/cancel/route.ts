import { emit } from '@/lib/orchestrator/events';
import { loadRun } from '@/lib/orchestrator/repository';
import { isTerminal } from '@/lib/orchestrator/types';
import { requireSession } from '@/lib/session';
import { getSupabaseServiceClient } from '@/lib/supabase/service';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Ask a run to stop.
 *
 * Cooperative, not forceful: the executor re-reads the run's status between
 * waves, so a cancel lands after the sub-agents currently in flight finish.
 * Saying otherwise would be a lie the API cannot back up — there is no way to
 * un-send a tool call that is already running.
 */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const user = await requireSession();
  const { id } = await params;
  const db = getSupabaseServiceClient();

  const run = await loadRun(db, id, user.organization.id);
  if (!run) return NextResponse.json({ error: 'Run not found' }, { status: 404 });
  if (isTerminal(run.status)) {
    return NextResponse.json({ status: run.status, cancelled: false });
  }

  // Guarded on status so a cancel racing the executor's own terminal write
  // cannot resurrect a run that just completed.
  const { data } = await db
    .from('orchestration_runs')
    .update({ status: 'cancelled', finished_at: new Date().toISOString() })
    .eq('id', id)
    .eq('organization_id', user.organization.id)
    .in('status', ['planning', 'running'])
    .select('id');

  const cancelled = (data ?? []).length > 0;
  if (cancelled) {
    await emit(db, id, null, 'error', { message: 'Cancelled by a person.' });
    await emit(db, id, null, 'run_done', { status: 'cancelled', summary: null });
  }

  return NextResponse.json({ status: cancelled ? 'cancelled' : run.status, cancelled });
}
