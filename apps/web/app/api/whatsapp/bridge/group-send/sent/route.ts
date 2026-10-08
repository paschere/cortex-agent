import { getOrgScopedClient } from '@/lib/supabase/service';
import { authorizeBridgeSession } from '@/lib/whatsapp/bridge';
import { ackGroupOutbox } from '@cortex/agent-tools';
import { logger } from '@cortex/core';
import { type NextRequest, NextResponse } from 'next/server';

/**
 * El puente dice si entregó un mensaje de Cortex a un grupo (0213), y con qué
 * id lo registró WhatsApp (es lo que otros citan al responder). Con alcance de
 * empresa; sólo se mueve lo que está «enviando», así que un acuse repetido o
 * tardío no reescribe nada.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = await authorizeBridgeSession(req);
  if (!auth.ok) return auth.response;

  const body = (await req.json().catch(() => ({}))) as {
    id?: string;
    ok?: boolean;
    messageId?: string | null;
    error?: string | null;
  };
  const id = (body.id ?? '').trim();
  if (!UUID.test(id)) return NextResponse.json({ error: 'id inválido' }, { status: 400 });

  try {
    await ackGroupOutbox(getOrgScopedClient(auth.caller.organizationId), {
      id,
      ok: body.ok === true,
      messageId: typeof body.messageId === 'string' ? body.messageId.slice(0, 80) : null,
      error: typeof body.error === 'string' ? body.error : null,
    });
  } catch (err) {
    logger.error(`whatsapp-grupos: no pude anotar la entrega — ${(err as Error).message}`);
    return NextResponse.json({ error: 'no se pudo anotar' }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
