import 'server-only';
import { appBaseUrl } from '@/lib/apps/automation-deps';
import { pushToAppUsers, pushToMembers } from '@/lib/apps/push';
import { sendEmail } from '@/lib/email';
import { notify } from '@/lib/notifications/notify';
import type { Assignee } from '@cortex/agent-tools';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * EL AVISO DE UNA TAREA ASIGNADA.
 *
 * Una tarea que nadie ve no se hace: al asignarla, la persona recibe un aviso
 * por el canal que tenga. Reutiliza las mismas piezas que `notify_app_user` de
 * las automatizaciones (push, y correo si no tiene push activo; la campana y el
 * push para un miembro de Cortex), sin inventar otra vía:
 *
 *   - usuario externo: push a SUS suscripciones en ESTA app; si no le llegó
 *     (sin llaves VAPID, sin suscripción o vencida), correo con el enlace;
 *   - miembro de Cortex: campana + push (si activó los avisos en esta app).
 *
 * El enlace abre la pantalla que dice el bloque (`Mis tareas`) con la fila.
 * Nunca lanza: asignar ya quedó guardado y un aviso caído no lo deshace.
 */

export interface AssignNoticeDeps {
  pushAppUsers: typeof pushToAppUsers;
  pushMembers: typeof pushToMembers;
  bell: typeof notify;
  email: typeof sendEmail;
  baseUrl: () => string;
}

const defaults: AssignNoticeDeps = {
  pushAppUsers: pushToAppUsers,
  pushMembers: pushToMembers,
  bell: notify,
  email: sendEmail,
  baseUrl: appBaseUrl,
};

export type AssignNoticeResult = 'push' | 'email' | 'bell' | 'none';

export async function notifyAssigned(
  db: SupabaseClient,
  input: {
    app: { id: string; slug: string; name: string };
    person: Pick<Assignee, 'kind' | 'id' | 'email' | 'name'>;
    task: { rowId: string; label: string; due?: string | null };
    screen: string | null;
    by: string;
  },
  deps: AssignNoticeDeps = defaults,
): Promise<AssignNoticeResult> {
  const { app, person, task } = input;
  const row = `?fila=${encodeURIComponent(task.rowId)}`;
  const path = `/a/${app.id}${input.screen ? `/${input.screen}` : ''}`;
  const title = `Nueva tarea: ${task.label}`.slice(0, 120);
  const body = `${input.by} te la asignó en «${app.name}»${task.due ? ` · para el ${task.due}` : ''}.`;
  const tag = `task:${task.rowId}`;
  try {
    if (person.kind === 'app_user') {
      const pushed = await deps
        .pushAppUsers(db, app.id, [person.id], { title, body, url: `${path}${row}`, tag })
        .catch(() => [] as string[]);
      if (pushed.includes(person.id)) return 'push';
      if (!person.email) return 'none';
      const out = await deps.email({
        to: person.email,
        subject: title,
        text: `${body}\n\nÁbrela aquí: ${deps.baseUrl()}${path}${row}\n\nAviso de «${app.name}».`,
      });
      return out.sent ? 'email' : 'none';
    }
    const id = await deps.bell(db, {
      userId: person.id,
      kind: 'view_activity',
      title,
      body,
      href: `/apps/${app.slug}${input.screen ? `/${input.screen}` : ''}${row}`,
      dedupeKey: `task:${task.rowId}:${person.id}`.slice(0, 190),
      groupKey: `appauto:${app.id}`,
    });
    const pushed = await deps
      .pushMembers(db, app.id, [person.id], { title, body, url: `${path}${row}`, tag })
      .catch(() => [] as string[]);
    return pushed.includes(person.id) ? 'push' : id ? 'bell' : 'none';
  } catch {
    return 'none';
  }
}
