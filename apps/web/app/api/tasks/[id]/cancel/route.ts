import { TASK_COLUMNS, taskFromRow } from '@/lib/background-tasks/repository';
import { canCancelTask } from '@/lib/background-tasks/scope';
import { canCancel } from '@/lib/background-tasks/status';
import { taskViewerFor } from '@/lib/background-tasks/viewer';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

/**
 * Cancelar. Si está «trabajando», sólo se pide: la tanda en curso lo ve en su
 * próximo latido (≤ 8 s) y se detiene; si espera (en cola, o te necesita), se
 * cancela ya y sus acciones paradas se rechazan para que nadie las apruebe después.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireSession();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id))
    return NextResponse.json({ error: 'No encontrada' }, { status: 404 });
  const db = getOrgScopedClient(user.organization.id);
  const { data } = await db
    .from('background_tasks')
    .select(TASK_COLUMNS)
    .eq('id', id)
    .maybeSingle();
  if (!data) return NextResponse.json({ error: 'No encontrada' }, { status: 404 });
  const task = taskFromRow(data as Record<string, unknown>);
  const viewer = await taskViewerFor(user);
  if (!canCancelTask(viewer, task))
    return NextResponse.json({ error: 'No encontrada' }, { status: 404 });
  if (!canCancel(task.status)) {
    return NextResponse.json({ error: 'Esa tarea ya terminó.' }, { status: 409 });
  }

  const now = new Date().toISOString();
  if (task.status === 'working') {
    await db
      .from('background_tasks')
      .update({ cancel_requested_at: now, updated_at: now })
      .eq('id', id);
    return NextResponse.json({ ok: true, status: 'working', cancelling: true });
  }

  const open = task.approvals.filter((a) => !a.decision).map((a) => a.id);
  if (open.length > 0) {
    await db
      .from('mcp_pending_actions')
      .update({ decision: 'declined', decided_at: now, decided_by: user.id, decided_via: 'web' })
      .in('id', open)
      .is('decision', null);
  }
  await db
    .from('background_tasks')
    .update({ status: 'cancelled', cancel_requested_at: now, finished_at: now, updated_at: now })
    .eq('id', id)
    .in('status', ['queued', 'needs_you']);
  return NextResponse.json({ ok: true, status: 'cancelled' });
}
