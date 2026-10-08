import { getOrgScopedClient } from '@/lib/supabase/service';
import { authorizeBridgeSession } from '@/lib/whatsapp/bridge';
import { type IncomingGroupMessage, recordGroupMessages } from '@cortex/agent-tools';
import { logger } from '@cortex/core';
import { type NextRequest, NextResponse } from 'next/server';

/**
 * Lo que se dice en los grupos con «Permitir mensajes de Cortex» (0213), para que
 * Cortex lea las respuestas (whatsapp.group_messages). Aparte del archivo de
 * Brain Knowledge: nada de esto se convierte en documento y se borra a los 7 días.
 *
 * Segunda llave: el puente ya filtra por la lista del latido, pero aquí se
 * vuelve a comprobar contra la base; un mensaje de un grupo no habilitado no
 * deja rastro.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = await authorizeBridgeSession(req);
  if (!auth.ok) return auth.response;

  const body = (await req.json().catch(() => ({}))) as { messages?: unknown };
  const list = Array.isArray(body.messages) ? (body.messages as Record<string, unknown>[]) : [];
  const messages: IncomingGroupMessage[] = [];
  for (const m of list.slice(0, 200)) {
    if (
      typeof m.groupJid !== 'string' ||
      !m.groupJid.endsWith('@g.us') ||
      typeof m.messageId !== 'string' ||
      typeof m.body !== 'string' ||
      typeof m.sentAt !== 'string' ||
      Number.isNaN(Date.parse(m.sentAt))
    )
      continue;
    messages.push({
      groupJid: m.groupJid,
      messageId: m.messageId.slice(0, 80),
      senderJid: typeof m.senderJid === 'string' ? m.senderJid.slice(0, 120) : null,
      senderName: typeof m.senderName === 'string' ? m.senderName.slice(0, 120) : null,
      sentAt: new Date(m.sentAt).toISOString(),
      body: m.body,
      quotedMessageId:
        typeof m.quotedMessageId === 'string' ? m.quotedMessageId.slice(0, 80) : null,
      quotedBody: typeof m.quotedBody === 'string' ? m.quotedBody : null,
    });
  }
  if (messages.length === 0) return NextResponse.json({ stored: 0 });

  try {
    const stored = await recordGroupMessages(
      getOrgScopedClient(auth.caller.organizationId),
      messages,
    );
    return NextResponse.json({ stored });
  } catch (err) {
    logger.error(`whatsapp-grupos: no pude guardar los mensajes — ${(err as Error).message}`);
    return NextResponse.json({ error: 'no se pudo guardar' }, { status: 500 });
  }
}
