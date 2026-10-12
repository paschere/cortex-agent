import { loadProducedFiles } from '@/lib/background-tasks/files-load';
import { TASK_COLUMNS, taskFromRow } from '@/lib/background-tasks/repository';
import { canSeeTask } from '@/lib/background-tasks/scope';
import { taskViewerFor } from '@/lib/background-tasks/viewer';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f-]{36}$/i;

/**
 * Los archivos producidos durante una tarea (`?taskId=`) o una conversación
 * (`?conversationId=`). Ven los de una conversación quien la tuvo y quien
 * administra la empresa; los de una tarea, su dueña y quien administra.
 */
export async function GET(req: Request) {
  const user = await requireSession();
  const url = new URL(req.url);
  const taskId = url.searchParams.get('taskId');
  const conversationId = url.searchParams.get('conversationId');
  const db = getOrgScopedClient(user.organization.id);
  const viewer = await taskViewerFor(user);
  const origin = url.origin;

  if (taskId) {
    if (!UUID.test(taskId)) return NextResponse.json({ error: 'No encontrada' }, { status: 404 });
    const { data } = await db
      .from('background_tasks')
      .select(TASK_COLUMNS)
      .eq('id', taskId)
      .maybeSingle();
    if (!data) return NextResponse.json({ error: 'No encontrada' }, { status: 404 });
    const task = taskFromRow(data as Record<string, unknown>);
    if (!canSeeTask(viewer, task))
      return NextResponse.json({ error: 'No encontrada' }, { status: 404 });
    const files = await loadProducedFiles(db, {
      userId: task.userId,
      conversationId: task.conversationId,
      from: task.startedAt ?? task.queuedAt,
      to: task.finishedAt,
      origin,
    });
    return NextResponse.json({ files });
  }

  if (conversationId) {
    if (!UUID.test(conversationId))
      return NextResponse.json({ error: 'No encontrada' }, { status: 404 });
    const { data } = await db
      .from('conversations')
      .select('id, user_id')
      .eq('id', conversationId)
      .maybeSingle();
    const conv = data as { id: string; user_id: string } | null;
    if (!conv || !canSeeTask(viewer, { userId: conv.user_id })) {
      return NextResponse.json({ error: 'No encontrada' }, { status: 404 });
    }
    const files = await loadProducedFiles(db, { userId: conv.user_id, conversationId, origin });
    return NextResponse.json({ files });
  }

  return NextResponse.json({ error: 'Falta taskId o conversationId' }, { status: 400 });
}
