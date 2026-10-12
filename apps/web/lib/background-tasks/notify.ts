import 'server-only';
import { sendEmail } from '@/lib/email';
import { notify } from '@/lib/notifications/notify';
import { pushToPeople } from '@/lib/notifications/push';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { logger } from '@cortex/core';
import type { TaskRecord } from './repository';

/**
 * AVISAR QUE UNA TAREA TERMINÓ, TE NECESITA O FALLÓ.
 *
 * Los tres canales de siempre y en el mismo orden que «Tu día»: la campana
 * (siempre, y con ella el aviso queda aunque no haya nada más), el push web, y
 * el correo sólo si el push no llegó a nadie —quien tiene el teléfono en la
 * mano no necesita además el correo—. Nada de esto lanza: la tarea ya terminó
 * y perder el recado no puede tumbarla.
 *
 * Una campanada por tarea y desenlace (`dedupeKey`): reintentar el trabajo no
 * repite el aviso.
 */

export type TaskNoticeKind = 'finished' | 'needs_you' | 'failed';

const KIND = {
  finished: 'task_finished',
  needs_you: 'task_needs_you',
  failed: 'task_failed',
} as const;

function short(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

export function noticeCopy(
  kind: TaskNoticeKind,
  task: Pick<TaskRecord, 'title' | 'error' | 'result'>,
  pendingSummary?: string,
): { title: string; body: string } {
  const what = short(task.title, 70);
  switch (kind) {
    case 'finished':
      return {
        title: `Tu tarea está lista: ${what}`,
        body: task.result
          ? short(task.result, 280)
          : 'Entra a la tarea para ver el resultado y sus archivos.',
      };
    case 'needs_you':
      return {
        title: `Una tarea te necesita: ${what}`,
        body: pendingSummary
          ? `${short(pendingSummary, 240)} Aprueba o rechaza y sigue sola.`
          : 'Dejó una acción esperando tu visto bueno. Apruébala o recházala y sigue sola.',
      };
    case 'failed':
      return {
        title: `La tarea no pudo terminar: ${what}`,
        body: task.error
          ? short(task.error, 280)
          : 'Entra a la tarea para ver hasta dónde llegó; puedes reintentarla.',
      };
  }
}

export async function noteTask(
  task: TaskRecord,
  kind: TaskNoticeKind,
  pendingSummary?: string,
): Promise<void> {
  try {
    const db = getOrgScopedClient(task.organizationId);
    const { title, body } = noticeCopy(kind, task, pendingSummary);
    const href = `/tareas/${task.id}`;
    // El segmento entra en la clave del «te necesita»: una tarea puede pedir varias veces.
    const dedupeKey =
      kind === 'needs_you'
        ? `task:${task.id}:needs_you:${task.segment}`
        : `task:${task.id}:${kind}`;
    const id = await notify(db, {
      userId: task.userId,
      kind: KIND[kind],
      title,
      body,
      href,
      source: { kind: 'task', id: task.id },
      dedupeKey,
    });
    if (!id) return;

    const pushed = await pushToPeople(db, [task.userId], {
      title,
      body,
      url: href,
      tag: dedupeKey,
    }).catch((err) => {
      logger.warn({ err, taskId: task.id }, 'tasks: el push no salió');
      return [] as string[];
    });
    if (pushed.length > 0) return;

    const { data } = await db.from('users').select('email').eq('id', task.userId).maybeSingle();
    const email = (data as { email?: string } | null)?.email;
    if (!email || !email.includes('@')) return;
    const base = (process.env.APP_BASE_URL ?? '').replace(/\/$/, '');
    await sendEmail({
      to: email,
      subject: title,
      text: `${body}\n\nAbrir la tarea: ${base}${href}`,
    });
  } catch (err) {
    logger.error({ err, taskId: task.id }, 'tasks: no se pudo avisar');
  }
}
