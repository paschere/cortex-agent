import { inngest } from '@/lib/inngest';
import { EVENT_RUN_CANCELLED } from '@/lib/orchestrator/contract';
import { emit } from '@/lib/orchestrator/events';
import { type LifecycleDb, settleUnfinishedTasks } from '@/lib/orchestrator/lifecycle';
import { loadRun } from '@/lib/orchestrator/repository';
import { isTerminal } from '@/lib/orchestrator/types';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { logger } from '@cortex/core';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Ask a run to stop.
 *
 * STILL COOPERATIVE, AND STILL SAID OUT LOUD. Two things now stop a run and
 * neither of them can reach into a sub-agent that is mid-tool-call:
 *
 *   1. the row is written `cancelled` here, and every phase of the executor
 *      re-reads it before starting the next thing;
 *   2. `orchestrator/run.cancelled` cancels the Inngest function, which lands
 *      at its next STEP boundary rather than its next wave.
 *
 * The second is what changed when execution moved off `after()`, and it makes
 * the stop land sooner — but "sooner" is not "instantly", and the API says so:
 * the response reports `settling` while sub-agents that were already working
 * finish what they were in the middle of. There is no way to un-send a tool
 * call that is already running, and pretending otherwise would be a lie the
 * interface would then have to repeat.
 */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const user = await requireSession();
  const { id } = await params;
  const db = getOrgScopedClient(user.organization.id);

  const run = await loadRun(db, id, user.organization.id);
  if (!run) return NextResponse.json({ error: 'Run not found' }, { status: 404 });
  if (isTerminal(run.status)) {
    return NextResponse.json({ status: run.status, cancelled: false, settling: false });
  }

  // Guarded on status so a cancel racing the executor's own terminal write
  // cannot resurrect a run that just completed.
  const { data } = await db
    .from('orchestration_runs')
    .update({ status: 'cancelled', finished_at: new Date().toISOString() })
    .eq('id', id)
    .in('status', ['planning', 'running'])
    .select('id');

  const cancelled = (data ?? []).length > 0;
  if (!cancelled) {
    return NextResponse.json({ status: run.status, cancelled: false, settling: false });
  }

  await emit(db, id, null, 'error', { message: 'Detuviste esta ejecución.' });
  await emit(db, id, null, 'run_done', { status: 'cancelled', summary: null });

  // The manifest would otherwise keep a spinner on every card whose sub-agent
  // was working — the same lie as the run pill, one level down. A sub-agent
  // that survives the cancel and finishes a moment later overwrites its own row
  // with the real result, which is the better outcome, so it is left to win.
  const settled = await settleUnfinishedTasks(db as unknown as LifecycleDb, id, 'cancelled');

  try {
    await inngest.send({
      name: EVENT_RUN_CANCELLED,
      data: { runId: id, organizationId: user.organization.id },
    });
  } catch (err) {
    // Best-effort: the row is already `cancelled`, which every phase of the
    // executor checks before it starts anything. The event only makes the stop
    // land at the next step instead of the next wave.
    logger.error('orchestrator: could not broadcast the cancellation', {
      runId: id,
      error: (err as Error).message,
    });
  }

  return NextResponse.json({ status: 'cancelled', cancelled: true, settling: settled > 0 });
}
