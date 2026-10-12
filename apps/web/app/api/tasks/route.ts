import { fetchUserNames } from '@/app/api/admin/_lib/audit-filters';
import {
  TASK_COLUMNS,
  TASK_RUN_JOB,
  taskFromRow,
  titleFromPrompt,
} from '@/lib/background-tasks/repository';
import { applyTaskScope } from '@/lib/background-tasks/scope';
import { TASK_STATUSES, isActive } from '@/lib/background-tasks/status';
import { taskViewerFor } from '@/lib/background-tasks/viewer';
import { enqueueJob } from '@/lib/jobs';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { loadAgent } from '@cortex/agents';
import { NextResponse } from 'next/server';
import { z } from 'zod';

export const runtime = 'nodejs';

/** Cuántas tareas activas puede tener una persona a la vez: cada una es un agente trabajando. */
const MAX_ACTIVE_PER_USER = 5;

const Body = z.object({
  prompt: z.string().trim().min(1).max(8000),
  /** Seguir en la conversación de siempre (un turno que se movió a segundo plano) o abrir una nueva. */
  conversationId: z.string().uuid().optional(),
  /** `continue`: el turno ya empezó en el chat y lo hecho está en la conversación. */
  mode: z.enum(['new', 'continue']).default('new'),
  title: z.string().trim().min(1).max(200).optional(),
});

/** Crear una tarea y encolarla. */
export async function POST(req: Request) {
  const user = await requireSession();
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  const { prompt, mode } = parsed.data;
  const db = getOrgScopedClient(user.organization.id);

  const { count } = await db
    .from('background_tasks')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', user.id)
    .in('status', ['queued', 'working', 'needs_you']);
  if ((count ?? 0) >= MAX_ACTIVE_PER_USER) {
    return NextResponse.json(
      {
        error: `Ya tienes ${MAX_ACTIVE_PER_USER} tareas en curso. Espera a que termine alguna o cancela una.`,
      },
      { status: 429 },
    );
  }

  let conversationId = parsed.data.conversationId;
  if (conversationId) {
    const { data: owned } = await db
      .from('conversations')
      .select('id')
      .eq('id', conversationId)
      .eq('user_id', user.id)
      .maybeSingle();
    if (!owned) {
      return NextResponse.json(
        { error: 'Esta conversación no está disponible para continuarla.' },
        { status: 403 },
      );
    }
    // Un turno ya movido a segundo plano no se duplica.
    if (mode === 'continue') {
      const { data: live } = await db
        .from('background_tasks')
        .select(TASK_COLUMNS)
        .eq('conversation_id', conversationId)
        .in('status', ['queued', 'working', 'needs_you'])
        .limit(1)
        .maybeSingle();
      if (live) {
        return NextResponse.json({
          task: taskFromRow(live as Record<string, unknown>),
          conversationId,
          already: true,
        });
      }
    }
  } else {
    const agent = await loadAgent(db, 'cortex').catch(() => null);
    if (!agent) return NextResponse.json({ error: 'Cortex no está disponible.' }, { status: 404 });
    const { data: conv, error } = await db
      .from('conversations')
      .insert({
        user_id: user.id,
        agent_id: agent.id,
        surface: 'web',
        title: (parsed.data.title ?? titleFromPrompt(prompt)).slice(0, 60),
      })
      .select('id')
      .single();
    if (error || !conv) {
      return NextResponse.json({ error: 'No se pudo crear la conversación.' }, { status: 500 });
    }
    conversationId = conv.id as string;
  }

  if (mode === 'new') {
    await db
      .from('messages')
      .insert({ conversation_id: conversationId, role: 'user', content: prompt });
  }

  const { data, error } = await db
    .from('background_tasks')
    .insert({
      user_id: user.id,
      conversation_id: conversationId,
      title: parsed.data.title ?? titleFromPrompt(prompt),
      prompt,
      mode,
    })
    .select(TASK_COLUMNS)
    .single();
  if (error || !data) {
    return NextResponse.json({ error: 'No se pudo crear la tarea.' }, { status: 500 });
  }
  const task = taskFromRow(data as Record<string, unknown>);

  const queued = await enqueueJob(TASK_RUN_JOB, {
    taskId: task.id,
    organizationId: user.organization.id,
  });
  if (!queued) {
    await db
      .from('background_tasks')
      .update({
        status: 'failed',
        error: 'No se pudo encolar la tarea. Inténtalo de nuevo en un momento.',
        finished_at: new Date().toISOString(),
      })
      .eq('id', task.id);
    return NextResponse.json(
      { error: 'No se pudo encolar la tarea. Inténtalo de nuevo en un momento.' },
      { status: 503 },
    );
  }
  return NextResponse.json({ task, conversationId });
}

/** Lista de tareas: las propias, o todas si administras la empresa. */
export async function GET(req: Request) {
  const user = await requireSession();
  const url = new URL(req.url);
  const status = url.searchParams.get('status');
  const active = url.searchParams.get('active') === '1';
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 50) || 50, 1), 200);
  const db = getOrgScopedClient(user.organization.id);
  const viewer = await taskViewerFor(user);

  let q = db
    .from('background_tasks')
    .select(TASK_COLUMNS)
    .order('created_at', { ascending: false })
    .limit(limit);
  q = applyTaskScope(q, viewer);
  if (status && (TASK_STATUSES as readonly string[]).includes(status)) q = q.eq('status', status);
  const { data, error } = await q;
  if (error)
    return NextResponse.json({ error: 'No se pudieron leer las tareas.' }, { status: 500 });
  let tasks = ((data ?? []) as Record<string, unknown>[]).map(taskFromRow);
  if (active) tasks = tasks.filter((t) => isActive(t.status));
  // Quien administra ve las de todos: con el nombre de la dueña en cada una.
  const owners = viewer.isManager
    ? await fetchUserNames(
        db,
        tasks.map((t) => t.userId),
      )
    : {};
  return NextResponse.json({
    tasks: tasks.map((t) => ({ ...t, ownerName: owners[t.userId] ?? null })),
    viewer: { id: viewer.id, isManager: viewer.isManager },
  });
}
