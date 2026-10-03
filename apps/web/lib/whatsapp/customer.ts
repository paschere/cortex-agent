import 'server-only';
import { notify } from '@/lib/notifications/notify';
import {
  type ConversationRow,
  type CustomerOutcome,
  type EscalationResult,
  customerDeps,
  handleCustomerMessage,
} from '@cortex/agent-tools';
import { logger } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * La atención a clientes por WhatsApp (0185), del lado de la app.
 *
 * Lo único que agrega sobre `handleCustomerMessage` es la campana: cuando una
 * conversación pasa a una persona, a esa persona le llega un aviso de trabajo
 * asignado que lleva a la conversación. Sin responsable configurado, el aviso
 * va a los administradores — una conversación escalada sin nadie que se entere
 * es un cliente esperando para siempre.
 */

export function atencionHref(conversationId: string): string {
  return `/integrations/whatsapp/atencion?c=${conversationId}`;
}

async function recipients(db: SupabaseClient, assigneeId: string | null): Promise<string[]> {
  if (assigneeId) return [assigneeId];
  const { data, error } = await db.from('users').select('id').eq('role', 'org_admin').limit(10);
  if (error) {
    logger.warn(`whatsapp-atencion: no pude leer los administradores — ${error.message}`);
    return [];
  }
  return ((data ?? []) as Array<{ id: string }>).map((u) => u.id);
}

export async function notifyEscalation(
  db: SupabaseClient,
  result: EscalationResult,
  conv: ConversationRow,
): Promise<void> {
  for (const userId of await recipients(db, result.assigneeId)) {
    await notify(db, {
      userId,
      kind: 'work_assigned',
      tone: 'warning',
      title: `Un cliente espera por WhatsApp: ${result.who}`.slice(0, 160),
      body: `${result.title}. Contesta desde Cortex; la respuesta sale en la misma conversación.`,
      href: atencionHref(conv.id),
      groupKey: `wa_customer:${conv.id}`,
    });
  }
}

/** Un mensaje de alguien que no es del equipo. `handled: false` = la atención está apagada. */
export function answerCustomer(
  db: SupabaseClient,
  input: {
    phone: string;
    jid: string;
    pushName: string | null;
    text: string;
    messageId: string | null;
  },
): Promise<CustomerOutcome> {
  return handleCustomerMessage(
    customerDeps(db, { onEscalated: (result, conv) => notifyEscalation(db, result, conv) }),
    input,
  );
}
