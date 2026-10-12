import 'server-only';
import { enqueueJob } from '@/lib/jobs';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { logger } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { TASK_RUN_JOB, type TaskRecord, loadTask } from './repository';
import { type TaskApproval, readyToResume } from './status';

/**
 * LA PERSONA RESPONDIÓ A UNA ACCIÓN PARADA: ANOTARLO Y, SI YA NO FALTA NINGUNA,
 * DESPERTAR LA TAREA.
 *
 * Lo llama la ruta de /api/approvals/[id] tras decidir (camino inmediato) y el
 * barrido (`sweepTasks`, que recoge lo decidido por otra superficie —Chat de
 * Google, WhatsApp— o vencido). Las dos cosas son idempotentes: anotar la misma
 * respuesta dos veces deja la misma fila, y encolar una tanda de más sólo
 * cuesta una reclamación fallida (`claim` en run.ts).
 */

export async function findTaskByApproval(
  db: SupabaseClient,
  approvalId: string,
): Promise<TaskRecord | null> {
  const { data } = await db
    .from('background_tasks')
    .select('id')
    .eq('status', 'needs_you')
    .contains('pending_approvals', [{ id: approvalId }])
    .limit(1)
    .maybeSingle();
  const id = (data as { id?: string } | null)?.id;
  return id ? loadTask(db, id) : null;
}

/** Aplica respuestas a las entradas de la tarea y devuelve la lista nueva. */
export function applyDecisions(
  list: readonly TaskApproval[],
  decisions: Record<string, Pick<TaskApproval, 'decision' | 'ok' | 'note'>>,
): TaskApproval[] {
  return list.map((a) => {
    const d = decisions[a.id];
    if (!d || a.decision) return a;
    return {
      ...a,
      ...(d.decision ? { decision: d.decision } : {}),
      ...(d.ok !== undefined ? { ok: d.ok } : {}),
      ...(d.note ? { note: d.note } : {}),
    };
  });
}

export async function recordApprovalDecision(opts: {
  organizationId: string;
  approvalId: string;
  decision: 'approved' | 'declined';
  ok?: boolean;
  note?: string;
}): Promise<{ resumed: boolean; taskId?: string }> {
  try {
    const db = getOrgScopedClient(opts.organizationId);
    const task = await findTaskByApproval(db, opts.approvalId);
    if (!task) return { resumed: false };
    const approvals = applyDecisions(task.approvals, {
      [opts.approvalId]: {
        decision: opts.decision,
        ...(opts.ok !== undefined ? { ok: opts.ok } : {}),
        ...(opts.note ? { note: opts.note } : {}),
      },
    });
    await db
      .from('background_tasks')
      .update({ pending_approvals: approvals, updated_at: new Date().toISOString() })
      .eq('id', task.id);
    if (!readyToResume(approvals)) return { resumed: false, taskId: task.id };
    const ok = await enqueueJob(TASK_RUN_JOB, {
      taskId: task.id,
      organizationId: opts.organizationId,
    });
    return { resumed: ok, taskId: task.id };
  } catch (err) {
    logger.warn({ err, approvalId: opts.approvalId }, 'tasks: no se pudo anotar la respuesta');
    return { resumed: false };
  }
}
