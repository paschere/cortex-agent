import { getOrgScopedClient } from '@/lib/supabase/service';
import { authorizeBridgeSession } from '@/lib/whatsapp/bridge';
import { ackOutbox } from '@cortex/agent-tools';
import { logger } from '@cortex/core';
import { type NextRequest, NextResponse } from 'next/server';

/**
 * El puente dice si entregó una respuesta de una persona (0185).
 *
 * La respuesta viajó en el latido (`outbox`), quedó en `enviando`, y aquí pasa
 * a `enviado` o `fallido`. Con alcance de espacio: el id de un mensaje de otra
 * empresa no encuentra fila. Sólo se mueve lo que está `enviando`, así que un
 * acuse repetido o tardío no reescribe nada.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = await authorizeBridgeSession(req);
  if (!auth.ok) return auth.response;

  const body = (await req.json().catch(() => ({}))) as { id?: string; ok?: boolean };
  const id = (body.id ?? '').trim();
  if (!UUID.test(id)) return NextResponse.json({ error: 'id inválido' }, { status: 400 });

  try {
    await ackOutbox(getOrgScopedClient(auth.caller.organizationId), {
      id,
      ok: body.ok === true,
    });
  } catch (err) {
    logger.error(`whatsapp-atencion: no pude anotar la entrega — ${(err as Error).message}`);
    return NextResponse.json({ error: 'no se pudo anotar' }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
