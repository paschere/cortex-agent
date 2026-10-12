import { TASK_COLUMNS, taskFromRow } from '@/lib/background-tasks/repository';
import { canSeeTask } from '@/lib/background-tasks/scope';
import { taskViewerFor } from '@/lib/background-tasks/viewer';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

/** Una tarea y su estado (la pantalla la consulta cada pocos segundos mientras sigue activa). */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
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
  if (!canSeeTask(viewer, task))
    return NextResponse.json({ error: 'No encontrada' }, { status: 404 });
  return NextResponse.json({ task });
}
