import 'server-only';
import {
  TASK_COLUMNS,
  TASK_RUN_JOB,
  taskFromRow,
  titleFromPrompt,
} from '@/lib/background-tasks/repository';
import { enqueueJob } from '@/lib/jobs';
import { loadAgent } from '@cortex/agents';
import { logger } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { DEFAULT_INTAKE_PREFS, type IntakePrefs, intakeLimit } from './shape';

/**
 * ARRANCAR UNA TAREA QUE LLEGÓ POR CORREO O POR WHATSAPP.
 *
 * El mismo camino de `POST /api/tasks` (conversación nueva, mensaje, tarea,
 * trabajo en la cola), con tres cosas más: (1) un registro por mensaje que lo
 * vuelve idempotente —el mismo correo o la misma entrega de WhatsApp no crea
 * dos tareas—, (2) un tope diario y de tareas vivas por persona, (3) una fila de
 * auditoría con la fuente. La tarea corre como la persona, con sus permisos y
 * sus confirmaciones; nada se envía solo.
 */

export type IntakeSource = 'email' | 'whatsapp';

export type IntakeResult =
  | { status: 'created'; taskId: string; title: string }
  | { status: 'duplicate' }
  | { status: 'limited'; reason: 'day' | 'active' }
  | { status: 'failed' };

export async function startIntakeTask(
  db: SupabaseClient,
  input: {
    organizationId: string;
    userId: string;
    source: IntakeSource;
    externalId: string;
    title: string;
    prompt: string;
  },
): Promise<IntakeResult> {
  const since = new Date(Date.now() - 24 * 3_600_000).toISOString();
  const [{ count: recent }, { count: active }] = await Promise.all([
    db
      .from('task_intake_log')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', input.userId)
      .eq('source', input.source)
      .gte('created_at', since),
    db
      .from('background_tasks')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', input.userId)
      .in('status', ['queued', 'working', 'needs_you']),
  ]);
  const limit = intakeLimit({
    source: input.source,
    startedLast24h: recent ?? 0,
    activeTasks: active ?? 0,
  });
  if (!limit.ok) return { status: 'limited', reason: limit.reason };

  // Reclamar el mensaje ANTES de crear nada: la restricción única es la que
  // decide la carrera entre dos barridos / dos entregas.
  const claim = await db
    .from('task_intake_log')
    .insert({
      user_id: input.userId,
      source: input.source,
      external_id: input.externalId,
    })
    .select('id')
    .single();
  if (claim.error || !claim.data) {
    const code = (claim.error as { code?: string } | null)?.code;
    return code === '23505' ? { status: 'duplicate' } : { status: 'failed' };
  }
  const claimId = (claim.data as { id: string }).id;
  const release = () =>
    db
      .from('task_intake_log')
      .delete()
      .eq('id', claimId)
      .then(undefined, () => undefined);

  try {
    const agent = await loadAgent(db, 'cortex').catch(() => null);
    if (!agent) throw new Error('agent unavailable');
    const title = (input.title || titleFromPrompt(input.prompt)).slice(0, 200);
    const { data: conv, error: convErr } = await db
      .from('conversations')
      .insert({
        user_id: input.userId,
        agent_id: agent.id,
        surface: 'web',
        title: title.slice(0, 60),
      })
      .select('id')
      .single();
    if (convErr || !conv) throw new Error('conversation');
    const conversationId = (conv as { id: string }).id;
    await db
      .from('messages')
      .insert({ conversation_id: conversationId, role: 'user', content: input.prompt });
    const { data, error } = await db
      .from('background_tasks')
      .insert({
        user_id: input.userId,
        conversation_id: conversationId,
        title,
        prompt: input.prompt,
        mode: 'new',
      })
      .select(TASK_COLUMNS)
      .single();
    if (error || !data) throw new Error('task');
    const task = taskFromRow(data as Record<string, unknown>);
    const queued = await enqueueJob(TASK_RUN_JOB, {
      taskId: task.id,
      organizationId: input.organizationId,
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
      return { status: 'failed' };
    }
    await db.from('task_intake_log').update({ task_id: task.id }).eq('id', claimId);
    await db
      .from('audit_events')
      .insert({
        user_id: input.userId,
        agent_id: agent.id,
        conversation_id: conversationId,
        tool_id: input.source === 'email' ? 'task.intake_email' : 'task.intake_whatsapp',
        input_hash: input.externalId.slice(0, 120),
        status: 'ok',
        latency_ms: 0,
        metadata: { taskId: task.id, source: input.source },
      })
      .then(undefined, () => undefined);
    return { status: 'created', taskId: task.id, title };
  } catch (err) {
    logger.warn({ err: (err as Error).message, source: input.source }, 'task intake failed');
    await release();
    return { status: 'failed' };
  }
}

// ---------------------------------------------------------------------------
// Preferencias
// ---------------------------------------------------------------------------

export async function loadIntakePrefs(
  db: SupabaseClient,
  userId: string,
): Promise<IntakePrefs & { emailEnabledAt: string | null }> {
  const { data } = await db
    .from('task_intake_prefs')
    .select('email_enabled, email_enabled_at, whatsapp_enabled, whatsapp_keyword')
    .eq('user_id', userId)
    .maybeSingle();
  const r = data as Record<string, unknown> | null;
  if (!r) return { ...DEFAULT_INTAKE_PREFS, emailEnabledAt: null };
  return {
    emailEnabled: r.email_enabled === true,
    whatsappEnabled: r.whatsapp_enabled === true,
    whatsappKeyword: typeof r.whatsapp_keyword === 'string' ? r.whatsapp_keyword : null,
    emailEnabledAt: typeof r.email_enabled_at === 'string' ? r.email_enabled_at : null,
  };
}

export async function saveIntakePrefs(
  db: SupabaseClient,
  userId: string,
  prefs: IntakePrefs,
): Promise<void> {
  const before = await loadIntakePrefs(db, userId);
  // Al encenderlo por primera vez (o de nuevo) sólo cuenta el correo desde ahora.
  const emailEnabledAt =
    prefs.emailEnabled && (!before.emailEnabled || !before.emailEnabledAt)
      ? new Date().toISOString()
      : before.emailEnabledAt;
  const { error } = await db.from('task_intake_prefs').upsert(
    {
      user_id: userId,
      email_enabled: prefs.emailEnabled,
      email_enabled_at: prefs.emailEnabled ? emailEnabledAt : null,
      whatsapp_enabled: prefs.whatsappEnabled,
      whatsapp_keyword: prefs.whatsappKeyword,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id' },
  );
  if (error) throw new Error('No se pudo guardar.');
}
