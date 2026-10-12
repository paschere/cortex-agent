import { TASK_COLUMNS, TASK_RUN_JOB, taskFromRow } from '@/lib/background-tasks/repository';
import { canRetryTask } from '@/lib/background-tasks/scope';
import { canRetry } from '@/lib/background-tasks/status';
import { taskViewerFor } from '@/lib/background-tasks/viewer';
import { enqueueJob } from '@/lib/jobs';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

/**
 * Reintentar: crea una tarea NUEVA (apunta a la anterior con `retry_of`) en la
 * misma conversación. Lo ya hecho está ahí; la nueva sigue desde ese punto con
 * los permisos de quien la reintenta.
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
  const old = taskFromRow(data as Record<string, unknown>);
  const viewer = await taskViewerFor(user);
  if (!canRetryTask(viewer, old))
    return NextResponse.json({ error: 'No encontrada' }, { status: 404 });
  if (!canRetry(old.status)) {
    return NextResponse.json(
      { error: 'Sólo se reintenta una tarea que falló o se canceló.' },
      { status: 409 },
    );
  }

  const { data: created, error } = await db
    .from('background_tasks')
    .insert({
      user_id: user.id,
      conversation_id: old.conversationId,
      title: old.title,
      prompt: old.prompt,
      mode: old.conversationId && old.segment > 0 ? 'continue' : 'new',
      retry_of: old.id,
    })
    .select(TASK_COLUMNS)
    .single();
  if (error || !created)
    return NextResponse.json({ error: 'No se pudo crear la tarea.' }, { status: 500 });
  const task = taskFromRow(created as Record<string, unknown>);
  const queued = await enqueueJob(TASK_RUN_JOB, {
    taskId: task.id,
    organizationId: user.organization.id,
  });
  if (!queued) {
    await db
      .from('background_tasks')
      .update({
        status: 'failed',
        error: 'No se pudo encolar la tarea.',
        finished_at: new Date().toISOString(),
      })
      .eq('id', task.id);
    return NextResponse.json({ error: 'No se pudo encolar la tarea.' }, { status: 503 });
  }
  return NextResponse.json({ task });
}
