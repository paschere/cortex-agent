'use server';

import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import type { AtencionResult } from '@/lib/whatsapp/atencion-shape';
import {
  closeConversation,
  customerSettingsSchema,
  getConversation,
  loadCustomerSettings,
  queueHumanReply,
  saveCustomerSettings,
  writeAuditEvent,
} from '@cortex/agent-tools';
import type { UUID } from '@cortex/core';
import { revalidatePath } from 'next/cache';

/**
 * LO QUE SE CAMBIA DESDE «ATENCIÓN POR WHATSAPP» (0185).
 *
 * Cada export es un endpoint que cualquiera con sesión puede llamar, así que
 * cada uno vuelve a mirar quién es:
 *   - Ajustes (encender, qué se comparte, horario, a quién se escala): sólo un
 *     administrador. Encender esto pone el número de la empresa a contestarle a
 *     desconocidos.
 *   - Responder y cerrar: un administrador, la persona a la que se le asignó la
 *     conversación, o la persona de escalamiento configurada.
 * El botón es la confirmación: lo que se escribe es lo que sale. Igual queda en
 * auditoría con la misma herramienta que usa el chat (`whatsapp.reply`).
 */

const PATH = '/integrations/whatsapp/atencion';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function message(err: unknown, fallback: string): string {
  const text = err instanceof Error ? err.message : '';
  return text && text.length < 300 ? text : fallback;
}

async function mayHandle(
  user: { id: string; role?: string | null },
  db: ReturnType<typeof getOrgScopedClient>,
  conversationId: string,
): Promise<string | null> {
  if (user.role === 'org_admin') return null;
  const [conv, settings] = await Promise.all([
    getConversation(db, conversationId),
    loadCustomerSettings(db),
  ]);
  if (!conv) return 'No encuentro esa conversación.';
  if (conv.assigned_to === user.id || settings.escalationUserId === user.id) return null;
  return 'Sólo un administrador o la persona que atiende esta conversación puede contestarla o cerrarla.';
}

export async function saveAtencionSettings(input: unknown): Promise<AtencionResult> {
  try {
    const user = await requireSession();
    if (user.role !== 'org_admin') {
      return { ok: false, error: 'Sólo un administrador puede cambiar la atención por WhatsApp.' };
    }
    const parsed = customerSettingsSchema.safeParse(input);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      return {
        ok: false,
        error: `Revisa ${first?.path.join(' › ') || 'los datos'}: ${first?.message ?? 'no es válido'}.`,
      };
    }
    const db = getOrgScopedClient(user.organization.id);
    if (parsed.data.escalationUserId) {
      const { data, error } = await db
        .from('users')
        .select('id')
        .eq('id', parsed.data.escalationUserId)
        .maybeSingle();
      if (error) throw error;
      if (!data) return { ok: false, error: 'Esa persona no está en esta empresa.' };
    }
    const saved = await saveCustomerSettings(db, parsed.data, user.id);
    revalidatePath(PATH);
    return {
      ok: true,
      note: saved.enabled
        ? 'Guardado. El número ya le contesta a los clientes que escriban.'
        : 'Guardado. La atención está apagada: a quien no es del equipo se le sigue contestando que el número es sólo para el equipo.',
    };
  } catch (err) {
    return { ok: false, error: message(err, 'No se pudo guardar. Intenta de nuevo.') };
  }
}

export async function replyAsPerson(input: {
  conversationId: string;
  text: string;
}): Promise<AtencionResult> {
  const started = performance.now();
  try {
    const user = await requireSession();
    const conversationId = String(input?.conversationId ?? '');
    if (!UUID_RE.test(conversationId)) return { ok: false, error: 'Conversación inválida.' };
    const db = getOrgScopedClient(user.organization.id);
    const refused = await mayHandle(user, db, conversationId);
    if (refused) return { ok: false, error: refused };

    const { messageId } = await queueHumanReply(db, {
      conversationId,
      text: String(input?.text ?? ''),
      userId: user.id,
    });
    await writeAuditEvent({
      db,
      userId: user.id as UUID,
      toolId: 'whatsapp.reply',
      input: { conversationId, length: String(input?.text ?? '').length },
      status: 'ok',
      latencyMs: Math.round(performance.now() - started),
      surface: 'web',
      decision: 'confirmed',
      metadata: { messageId, from: 'atencion' },
    });
    revalidatePath(PATH);
    return { ok: true, note: 'En cola: sale por WhatsApp en menos de un minuto.' };
  } catch (err) {
    return { ok: false, error: message(err, 'No se pudo enviar. Intenta de nuevo.') };
  }
}

export async function closeAtencionConversation(input: {
  conversationId: string;
}): Promise<AtencionResult> {
  try {
    const user = await requireSession();
    const conversationId = String(input?.conversationId ?? '');
    if (!UUID_RE.test(conversationId)) return { ok: false, error: 'Conversación inválida.' };
    const db = getOrgScopedClient(user.organization.id);
    const refused = await mayHandle(user, db, conversationId);
    if (refused) return { ok: false, error: refused };
    await closeConversation(db, { conversationId, userId: user.id });
    revalidatePath(PATH);
    return {
      ok: true,
      note: 'Cerrada. Si el cliente vuelve a escribir, se abre una conversación nueva.',
    };
  } catch (err) {
    return { ok: false, error: message(err, 'No se pudo cerrar. Intenta de nuevo.') };
  }
}
