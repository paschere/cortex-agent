import 'server-only';
import { appBaseUrl } from '@/lib/email-templates';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { loadIntakePrefs, startIntakeTask } from './create';
import {
  MAX_ACTIVE_TASKS,
  WHATSAPP_PER_DAY,
  parseWhatsappTrigger,
  whatsappAck,
  whatsappExternalId,
  whatsappGate,
} from './shape';

/**
 * «CORTEX, …» POR WHATSAPP → UNA TAREA EN SEGUNDO PLANO.
 *
 * Se llama desde la ruta de mensajes directos del puente SÓLO después de
 * resolver a la persona (número vinculado por un admin) y comprobar que el
 * mensaje es de su empresa. Un número desconocido nunca llega aquí: sigue el
 * flujo de siempre (negativa o atención a clientes). Si no hay disparador, o la
 * persona no lo encendió, devuelve `null` y el mensaje sigue su camino normal.
 * La respuesta sale por la misma conversación abierta (ventana de 24 h), con un
 * acuse corto y el enlace; nada más se envía.
 */

export interface WhatsappTaskReply {
  reply: string | null;
}

export async function tryWhatsappTask(input: {
  organizationId: string;
  bridgeOrganizationId: string;
  userId: string;
  displayName: string | null;
  phone: string;
  text: string;
  messageId: string | null;
  now?: Date;
}): Promise<WhatsappTaskReply | null> {
  const db = getOrgScopedClient(input.organizationId);
  const prefs = await loadIntakePrefs(db, input.userId);
  const gate = whatsappGate({
    sender: { organizationId: input.organizationId, userId: input.userId },
    bridgeOrganizationId: input.bridgeOrganizationId,
    prefs,
  });
  if (!gate.ok) return null;
  const trigger = parseWhatsappTrigger(input.text, prefs.whatsappKeyword);
  if (!trigger) return null;

  const result = await startIntakeTask(db, {
    organizationId: input.organizationId,
    userId: input.userId,
    source: 'whatsapp',
    externalId: whatsappExternalId({
      messageId: input.messageId,
      phone: input.phone,
      text: input.text,
      now: input.now ?? new Date(),
    }),
    title: '',
    prompt: `${trigger.task}\n\n(Pedido por WhatsApp. Responde aquí con el resultado; no envíes nada por tu cuenta.)`,
  });

  switch (result.status) {
    case 'created':
      return {
        reply: whatsappAck({
          name: input.displayName,
          title: result.title,
          url: `${appBaseUrl()}/tareas/${result.taskId}`,
        }),
      };
    case 'duplicate':
      return { reply: null };
    case 'limited':
      return {
        reply:
          result.reason === 'day'
            ? `Hoy ya empecé ${WHATSAPP_PER_DAY} tareas desde WhatsApp. Las demás pídemelas desde la app o mañana.`
            : `Ya tienes ${MAX_ACTIVE_TASKS} tareas en curso. Espera a que termine alguna o cancela una en la app.`,
      };
    default:
      return { reply: 'No pude empezar esa tarea. Vuelve a escribirme en un momento.' };
  }
}
