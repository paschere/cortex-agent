import { loadErrand } from '@/lib/errands/repository';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { type ErrandDb, closeErrand, withdrawOpenQuestions } from '@cortex/agent-tools';
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
 * always have — cancelled on the row, which the executor re-reads between
 * phases and before starting each sub-agent. (The `orchestrator/run.cancelled`
 * event died with Inngest's `cancelOn`; the row was always the authority.)
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
    // La fila es toda la señal: el executor la relee entre fases y antes de
    // arrancar cada sub-agente (lib/orchestrator/executor.ts), así que no hay
    // evento que mandar. Exactamente lo que hace app/api/orchestrator/[id]/cancel.
    const { data } = await db
      .from('orchestration_runs')
      .update({ status: 'cancelled', finished_at: new Date().toISOString() })
      .eq('id', runId)
      .in('status', ['planning', 'running'])
      .select('id');
    settling = (data ?? []).length > 0;
  }

  return NextResponse.json({ ok: true, settling });
}
