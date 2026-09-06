import { notify } from '@/lib/notifications/notify';
import {
  type Operation,
  bogotaToday,
  operationDay,
  readManagement,
  readOperationEvents,
} from '@cortex/agent-tools';
import type { SupabaseClient } from '@supabase/supabase-js';
/** Opt-in, in-app only. Event identity remains stable after reading a notification. */
export async function notifyOperationAttention(db: SupabaseClient, id: string) {
  const r = await db
    .from('management_operations')
    .select('id,data,state,revision,created_at,updated_at')
    .eq('id', id)
    .maybeSingle();
  if (r.error) throw new Error('No se pudo leer el ciclo.');
  const op = r.data as Operation | null;
  if (!op || op.state !== 'active' || !op.data.notifyInApp) return { notified: 0 };
  const today = bogotaToday();
  if (operationDay(op.data.startOn, today) < 1) return { notified: 0 };
  const [board, history] = await Promise.all([readManagement(db), readOperationEvents(db, id)]);
  // A partial graph cannot safely declare dependencies resolved.
  if (board.truncated || history.truncated)
    throw new Error('Lectura parcial del ciclo; revisar la operación.');
  const notices: { userId: string; key: string; title: string; body: string }[] = [];
  const valid = (userId: string) => board.people.some((p) => p.id === userId);
  for (const c of board.cases.filter(
    (c) => op.data.caseIds.includes(c.id) && !['verified', 'cancelled'].includes(c.data.state),
  )) {
    if (c.data.ownerId && valid(c.data.ownerId) && c.data.nextReviewOn <= today)
      notices.push({
        userId: c.data.ownerId,
        key: `case:${c.id}:${c.data.ownerId}:${c.data.nextReviewOn}`,
        title: 'Te corresponde revisar un asunto',
        body: `${c.data.title}: ${c.data.nextAction}. Registra el avance o explica qué te bloquea.`,
      });
    if (
      (!c.data.ownerId || c.data.state === 'blocked' || c.data.state === 'review') &&
      valid(op.data.ownerId)
    )
      notices.push({
        userId: op.data.ownerId,
        key: `attention:${c.id}:${c.data.state}:${c.data.ownerId ?? 'none'}:${c.data.nextReviewOn}`,
        title: 'El ciclo necesita coordinación',
        body: `${c.data.title}: ${c.data.blocker || 'Revisa responsable o evidencia de cierre.'}`,
      });
  }
  for (const day of [7, 14, 21, 30])
    if (
      operationDay(op.data.startOn, today) >= day &&
      !history.events.some((e) => e.data.kind === 'checkpoint' && e.data.checkpoint.day === day) &&
      valid(op.data.ownerId)
    )
      notices.push({
        userId: op.data.ownerId,
        key: `checkpoint:${day}`,
        title: `Revisión pendiente del día ${day}`,
        body: 'Coordina con un administrador la medición, evidencia y aprendizaje de este tramo.',
      });
  for (const e of history.events)
    if (
      e.data.kind === 'decision' &&
      e.data.decision.dueOn <= today &&
      !history.events.some((r) => r.data.kind === 'resolve' && r.data.decisionId === e.id) &&
      valid(op.data.ownerId)
    )
      notices.push({
        userId: op.data.ownerId,
        key: `decision:${e.id}`,
        title: 'Hay una decisión pendiente en el ciclo',
        body: e.data.decision.question,
      });
  let notified = 0;
  for (const n of notices) {
    // Pauses and notification opt-out are checked again at the delivery boundary.
    const current = await db
      .from('management_operations')
      .select('state,data')
      .eq('id', id)
      .single();
    if (current.error) throw new Error('No se pudo comprobar el estado antes de avisar.');
    if (current.data.state !== 'active' || !current.data.data.notifyInApp) break;
    const saved = await notify(db, {
      userId: n.userId,
      kind: 'management_attention',
      title: n.title,
      body: n.body,
      href: `/management/operation?id=${id}`,
      dedupeKey: `operation:${id}:${n.key}`,
    });
    if (!saved) throw new Error('No se pudo registrar el aviso del ciclo.');
    notified++;
  }
  return { notified };
}
