import 'server-only';
import { enqueueJob } from '@/lib/jobs';
import { getOrgScopedClient, getSupabaseServiceClient } from '@/lib/supabase/service';
import { logger } from '@cortex/core';
import { noteTask } from './notify';
import { TASK_RUN_JOB, type TaskRecord, loadTask } from './repository';
import { applyDecisions } from './resume';
import { STALE_AFTER_MS, openApprovals, readyToResume } from './status';

/**
 * EL BARRIDO: NINGUNA TAREA SE QUEDA «TRABAJANDO» PARA SIEMPRE.
 *
 * Cada cinco minutos recoge lo que nadie más va a recoger:
 *   - una tanda MUERTA (la plataforma la mató; sin latido hace más de 5 min) →
 *     se encola otra, salvo que ya pasó el tope o ya van demasiadas;
 *   - un trabajo PERDIDO (la tarea sigue «en cola» o entre tandas sin que
 *     ninguna corra) → se vuelve a encolar;
 *   - acciones paradas que se decidieron por OTRA superficie (Chat de Google,
 *     WhatsApp) o VENCIERON → se anotan y, si ya no falta ninguna, la tarea sigue;
 *   - una tarea que lleva dos días esperando a la persona → se cancela.
 *
 * Retiene un cliente SIN alcance de empresa a propósito (misma razón que
 * orchestrator-sweep.ts): la pregunta «qué tareas de toda la instalación están
 * atascadas» no tiene empresa a la que acotarse. Sólo hace un SELECT de ids; toda
 * escritura posterior pasa por un cliente atado a la empresa de la tarea.
 */

const MAX_PER_PASS = 100;
const MAX_SEGMENTS = 12;
const QUEUED_LOST_MS = 3 * 60_000;
const WAITING_TOO_LONG_MS = 48 * 60 * 60_000;

interface Candidate {
  id: string;
  organization_id: string;
}

export interface SweepTally {
  requeued: number;
  failed: number;
  resumed: number;
  cancelled: number;
}

export async function sweepTasks(now: Date = new Date()): Promise<SweepTally> {
  const tally: SweepTally = { requeued: 0, failed: 0, resumed: 0, cancelled: 0 };
  const raw = getSupabaseServiceClient();
  const { data, error } = await raw
    .from('background_tasks')
    .select('id, organization_id')
    .in('status', ['queued', 'working', 'needs_you'])
    .order('updated_at', { ascending: true })
    .limit(MAX_PER_PASS);
  if (error) {
    logger.error({ error: error.message }, 'tasks sweep: no se pudo leer');
    return tally;
  }

  for (const c of (data ?? []) as Candidate[]) {
    try {
      const db = getOrgScopedClient(c.organization_id);
      const task = await loadTask(db, c.id);
      if (!task) continue;
      await sweepOne(db, task, now, tally);
    } catch (err) {
      logger.warn({ err, taskId: c.id }, 'tasks sweep: una tarea falló');
    }
  }
  return tally;
}

async function failTask(
  db: ReturnType<typeof getOrgScopedClient>,
  task: TaskRecord,
  message: string,
  tally: SweepTally,
) {
  await db
    .from('background_tasks')
    .update({
      status: 'failed',
      error: message,
      finished_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', task.id);
  tally.failed += 1;
  await noteTask({ ...task, status: 'failed', error: message }, 'failed');
}

async function requeue(task: TaskRecord, tally: SweepTally, field: 'requeued' | 'resumed') {
  const ok = await enqueueJob(TASK_RUN_JOB, {
    taskId: task.id,
    organizationId: task.organizationId,
  });
  if (ok) tally[field] += 1;
}

async function sweepOne(
  db: ReturnType<typeof getOrgScopedClient>,
  task: TaskRecord,
  now: Date,
  tally: SweepTally,
) {
  const age = (iso: string | null) => (iso ? now.getTime() - new Date(iso).getTime() : 0);

  if (task.cancelRequestedAt && task.status !== 'working') {
    await db
      .from('background_tasks')
      .update({
        status: 'cancelled',
        finished_at: now.toISOString(),
        updated_at: now.toISOString(),
      })
      .eq('id', task.id);
    tally.cancelled += 1;
    return;
  }

  if (task.status === 'queued') {
    if (age(task.queuedAt) > QUEUED_LOST_MS && age(task.updatedAt) > QUEUED_LOST_MS) {
      await requeue(task, tally, 'requeued');
    }
    return;
  }

  if (task.status === 'working') {
    const silent = task.heartbeatAt
      ? age(task.heartbeatAt) > STALE_AFTER_MS
      : age(task.updatedAt) > QUEUED_LOST_MS;
    if (!silent) return;
    const capPassed = task.deadlineAt
      ? new Date(task.deadlineAt).getTime() <= now.getTime()
      : false;
    if (capPassed) {
      await failTask(
        db,
        task,
        'La tarea se interrumpió y ya había llegado a su tope de 20 minutos. Lo avanzado quedó en la conversación.',
        tally,
      );
    } else if (task.segment >= MAX_SEGMENTS) {
      await failTask(db, task, 'La tarea se interrumpió demasiadas veces.', tally);
    } else {
      // Se suelta la reclamación vieja para que la nueva tanda pueda tomarla.
      await db
        .from('background_tasks')
        .update({
          heartbeat_at: null,
          updated_at: new Date(now.getTime() - QUEUED_LOST_MS - 1).toISOString(),
        })
        .eq('id', task.id);
      await requeue(task, tally, 'requeued');
    }
    return;
  }

  // needs_you
  if (age(task.updatedAt) > WAITING_TOO_LONG_MS && openApprovals(task.approvals).length > 0) {
    await db
      .from('background_tasks')
      .update({
        status: 'cancelled',
        error: 'Esperó dos días tu respuesta y se cerró.',
        finished_at: now.toISOString(),
        updated_at: now.toISOString(),
      })
      .eq('id', task.id);
    tally.cancelled += 1;
    return;
  }

  const open = openApprovals(task.approvals);
  if (open.length > 0) {
    const { data } = await db
      .from('mcp_pending_actions')
      .select('id, decision, expires_at')
      .in(
        'id',
        open.map((a) => a.id),
      );
    const rows = (data ?? []) as Array<{ id: string; decision: string | null; expires_at: string }>;
    const decisions: Record<
      string,
      { decision: 'approved' | 'declined'; ok?: boolean; note?: string }
    > = {};
    for (const a of open) {
      const row = rows.find((r) => r.id === a.id);
      if (!row) {
        decisions[a.id] = { decision: 'declined', note: 'ya no existe' };
      } else if (row.decision === 'approved') {
        decisions[a.id] = { decision: 'approved', ok: true };
      } else if (row.decision === 'declined') {
        decisions[a.id] = { decision: 'declined' };
      } else if (new Date(row.expires_at).getTime() <= now.getTime()) {
        decisions[a.id] = { decision: 'declined', note: 'venció sin respuesta' };
      }
    }
    if (Object.keys(decisions).length === 0) return;
    const approvals = applyDecisions(task.approvals, decisions);
    await db
      .from('background_tasks')
      .update({ pending_approvals: approvals, updated_at: now.toISOString() })
      .eq('id', task.id);
    if (readyToResume(approvals)) await requeue(task, tally, 'resumed');
    return;
  }

  // Todas respondidas pero nadie despertó la tarea.
  if (readyToResume(task.approvals) && age(task.updatedAt) > QUEUED_LOST_MS) {
    await requeue(task, tally, 'resumed');
  }
}
