import { emit } from '@/lib/orchestrator/events';
import { type LifecycleDb, settleUnfinishedTasks } from '@/lib/orchestrator/lifecycle';
import { loadRun } from '@/lib/orchestrator/repository';
import { isTerminal } from '@/lib/orchestrator/types';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Ask a run to stop.
 *
 * STILL COOPERATIVE, AND STILL SAID OUT LOUD. La fila es la única señal: aquí
 * se escribe `cancelled`, y el executor la relee entre fases Y antes de
 * arrancar cada sub-agente (lib/orchestrator/executor.ts). El evento
 * `orchestrator/run.cancelled` murió con el `cancelOn` de Inngest — pg-boss no
 * tiene cancelación por evento, y no hace falta: el chequeo por tarea corta
 * antes de lo que aquel evento cortaba (el siguiente paso ≈ la siguiente ola).
 *
 * "Antes" no es "al instante", y la API lo dice: la respuesta reporta
 * `settling` mientras los sub-agentes que ya estaban dentro de una herramienta
 * terminan ese paso. Una llamada ya enviada no se puede devolver, y fingir lo
 * contrario sería una mentira que la interfaz tendría que repetir.
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

  return NextResponse.json({ status: 'cancelled', cancelled: true, settling: settled > 0 });
}
