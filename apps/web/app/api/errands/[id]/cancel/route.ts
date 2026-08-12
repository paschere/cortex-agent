import { type ErrandDb, closeErrand, withdrawOpenQuestions } from '@/lib/errands/lifecycle';
import { loadErrand } from '@/lib/errands/repository';
import { inngest } from '@/lib/inngest';
import { EVENT_RUN_CANCELLED } from '@/lib/orchestrator/contract';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { logger } from '@cortex/core';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Stop an errand.
 *
 * ── COOPERATIVE, AND HONEST ABOUT IT ──────────────────────────────────────
 *
 * Two things have to stop and they stop at different speeds. The ERRAND stops
 * immediately: the row is written terminal here, and every conditional update
 * in the engine refuses to move an errand that is not live, so no further leg
 * can be commissioned no matter which worker wakes up next. The LEG currently
 * running is an orchestrator run, and that stops the way orchestrator runs
 * always have — cancelled on the row, then cancelled at its next step boundary
 * by the `orchestrator/run.cancelled` event.
 *
 * So a sub-agent already inside a tool call finishes that call. A request
 * already sent cannot be un-sent, and pretending otherwise would just move the
 * lie one screen over. The reply says which of the two happened so the screen
 * can say it too.
 *
 * The errand is written terminal BEFORE the run is cancelled, deliberately: if
 * this request dies in between, what is left is a stopped errand with a run
 * that the orchestrator's own sweep will close within fifteen minutes. The
 * other order would leave a live errand that immediately commissions a
 * replacement leg for the one just cancelled.
 */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const user = await requireSession();
  const { id } = await params;
  const db = getOrgScopedClient(user.organization.id);

  const errand = await loadErrand(db, id, user.organization.id);
  if (!errand) return NextResponse.json({ error: 'No existe ese encargo.' }, { status: 404 });

  const runId = errand.view.currentRunId;

  const stopped = await closeErrand(db as unknown as ErrandDb, {
    errandId: id,
    state: 'cancelled',
    closingNote:
      'Lo detuviste. Lo que alcanzó a reunir antes de pararlo quedó guardado y no se lanzó nada ' +
      'más. Si tenía una vuelta a medias, los subagentes que estaban dentro de una herramienta ' +
      'terminan ese paso: una llamada ya enviada no se puede devolver.',
  });

  if (!stopped) {
    return NextResponse.json(
      { ok: true, alreadyFinished: true, state: errand.view.state },
      { status: 200 },
    );
  }

  await withdrawOpenQuestions(db as unknown as ErrandDb, id);

  let settling = false;
  if (runId) {
    // Row first, then the event: the row is the authority and the event only
    // makes the stop land at the next step instead of the next wave. Exactly
    // the order app/api/orchestrator/[id]/cancel uses.
    const { data } = await db
      .from('orchestration_runs')
      .update({ status: 'cancelled', finished_at: new Date().toISOString() })
      .eq('id', runId)
      .in('status', ['planning', 'running'])
      .select('id');
    settling = (data ?? []).length > 0;

    if (settling) {
      try {
        await inngest.send({
          name: EVENT_RUN_CANCELLED,
          data: { runId, organizationId: user.organization.id },
        });
      } catch (err) {
        // The row already says cancelled, and the executor re-reads it between
        // phases. The event only makes it land sooner.
        logger.error('errands: could not signal the running leg to stop', {
          errandId: id,
          runId,
          error: (err as Error).message,
        });
      }
    }
  }

  return NextResponse.json({ ok: true, settling });
}
