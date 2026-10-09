import type { NotificationAction } from '@/lib/notifications-shape';

/**
 * EJECUTAR UN BOTÓN DE UN AVISO (0220), SIN SABER DE BASES NI DE REDES.
 *
 * Un botón nunca lleva una herramienta: lleva la referencia a una cosa del
 * piloto (id + huella). Aquí sólo se decide si ESTA persona puede pulsar ESTE
 * botón de ESTE aviso, y se delega la decisión de fondo en el mismo camino que
 * `ItemDecision` usa en /piloto (`decideAutopilotItem`: administrador o dueño,
 * huella vigente, reclamo atómico, auditoría de `runTool`). Los permisos no se
 * duplican aquí: se heredan.
 *
 *   404  el aviso no es suyo (o no existe, o ya no es miembro de esa empresa)
 *   400  el botón no existe en ese aviso, o la decisión no es una de las dos
 *   409  el camino del piloto lo rechazó: no es administrador, cambió desde
 *        que se mostró, ya la decidieron, falló al ejecutarse
 *   200  hecho
 */

export type ActionDecision = 'approve' | 'dismiss';

export type DecideResult =
  | { ok: true; status: 'done' | 'dismissed' | 'failed' | 'asked'; message: string }
  | { ok: false; message: string };

export interface ActionDeps {
  find: (
    baUserId: string,
    target: { id: string; organizationId: string },
  ) => Promise<{ directoryUserId: string; actions: NotificationAction[] } | null>;
  decide: (input: {
    organizationId: string;
    userId: string;
    itemId: string;
    decision: ActionDecision;
    contentHash: string;
  }) => Promise<DecideResult>;
  markRead: (baUserId: string, target: { id: string; organizationId: string }) => Promise<void>;
}

export interface ActionInput {
  baUserId: string;
  notificationId: string;
  organizationId: string;
  index: number;
  decision: ActionDecision;
}

export interface ActionOutcome {
  httpStatus: 200 | 400 | 404 | 409;
  ok: boolean;
  note: string;
}

export async function runNotificationAction(
  deps: ActionDeps,
  input: ActionInput,
): Promise<ActionOutcome> {
  if (input.decision !== 'approve' && input.decision !== 'dismiss')
    return { httpStatus: 400, ok: false, note: 'Decisión desconocida.' };
  const target = { id: input.notificationId, organizationId: input.organizationId };
  const found = await deps.find(input.baUserId, target);
  if (!found) return { httpStatus: 404, ok: false, note: 'Ese aviso ya no está.' };
  const action = found.actions[input.index];
  if (!action) return { httpStatus: 400, ok: false, note: 'Ese aviso no tiene ese botón.' };

  // El usuario del directorio sale de la membresía comprobada arriba, nunca del
  // cuerpo de la petición.
  const result = await deps.decide({
    organizationId: input.organizationId,
    userId: found.directoryUserId,
    itemId: action.itemId,
    decision: input.decision,
    contentHash: action.contentHash,
  });
  if (!result.ok) return { httpStatus: 409, ok: false, note: result.message };
  const failed = result.status === 'failed' || result.status === 'asked';
  if (!failed) await deps.markRead(input.baUserId, target).catch(() => undefined);
  return failed
    ? { httpStatus: 409, ok: false, note: result.message }
    : { httpStatus: 200, ok: true, note: result.message };
}
