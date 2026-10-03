import { getSupabaseServiceClient } from '@/lib/supabase/service';
import { authenticateBridgeControl } from '@/lib/whatsapp/bridge';
import { PAIRING_REQUEST_TTL_MS } from '@/lib/whatsapp/pairing';
import { logger } from '@cortex/core';
import { type NextRequest, NextResponse } from 'next/server';

/**
 * QUÉ EMPRESAS NECESITAN UNA CONEXIÓN DE WHATSAPP, Y CUÁLES SON DE ESTE PROCESO
 * (migración 0189).
 *
 * El puente multiempresa pregunta aquí cada ~15 s. Cortex es la fuente de la
 * verdad: necesita conexión una empresa cuya sesión guardada está emparejada
 * (tiene que estar conectada para recibir) o donde un administrador está
 * vinculando ahora mismo. Las demás no tienen socket, como antes: un número sin
 * vincular no le habla a WhatsApp si nadie lo pidió.
 *
 * La respuesta es un PRÉSTAMO: `whatsapp_bridge_claim` presta a este proceso
 * las que estén libres o vencidas, hasta su techo, y suelta las que ya no le
 * tocan, todo en una transacción. Dos procesos no reciben la misma empresa
 * mientras el préstamo viva, que es lo que impide que dos clientes se peleen
 * por una sesión durante un deploy.
 *
 *   { action: 'claim', mode, maxSessions, leaseMs, organizationId?, running }
 *   { action: 'release' }   — al apagarse: suelta todo lo de este proceso.
 *
 * Usa el cliente sin alcance (está en la lista de tenancy-guard): la pregunta
 * es sobre todas las empresas a la vez, como un despachador de cron, y lo que
 * sale son ids de espacio y un sí/no por cada uno — nunca credenciales ni
 * contenido. Todo lo demás que el puente hace después va por las rutas por
 * empresa, con su cliente con alcance.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ORG_ID = /^[A-Za-z0-9._:-]{1,128}$/;

interface ClaimBody {
  action?: unknown;
  maxSessions?: unknown;
  leaseMs?: unknown;
  organizationId?: unknown;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.min(max, Math.max(min, n));
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = authenticateBridgeControl(req);
  if (!auth.ok) return auth.response;
  const { mode, instanceId } = auth.caller;

  const body = (await req.json().catch(() => ({}))) as ClaimBody;
  const db = getSupabaseServiceClient();

  if (body.action === 'release') {
    const released = await db.rpc('whatsapp_bridge_release', { p_instance: instanceId });
    if (released.error) {
      logger.error(`whatsapp-bridge: could not release — ${released.error.message}`);
      return NextResponse.json({ error: 'Could not release' }, { status: 500 });
    }
    return NextResponse.json({ ok: true, released: released.data ?? 0 });
  }

  if (body.action !== 'claim') {
    return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  }

  const organizationId =
    typeof body.organizationId === 'string' && ORG_ID.test(body.organizationId)
      ? body.organizationId
      : null;
  if (mode === 'single' && !organizationId) {
    return NextResponse.json({ error: 'Single mode needs its workspace' }, { status: 400 });
  }

  const claimed = await db.rpc('whatsapp_bridge_claim', {
    p_instance: instanceId,
    p_mode: mode,
    p_max_sessions: clampInt(body.maxSessions, 1, 1000, 50),
    p_lease_seconds: Math.round(clampInt(body.leaseMs, 15_000, 10 * 60_000, 60_000) / 1000),
    p_organization_id: mode === 'single' ? organizationId : null,
    p_pairing_ttl_seconds: Math.round(PAIRING_REQUEST_TTL_MS / 1000),
  });
  if (claimed.error) {
    logger.error(`whatsapp-bridge: could not claim sessions — ${claimed.error.message}`);
    // 503, not 500: the bridge keeps its sockets while its lease is alive and
    // asks again next round. See services/whatsapp/src/reconcile.ts.
    return NextResponse.json({ error: 'Could not claim sessions' }, { status: 503 });
  }

  return NextResponse.json(claimed.data ?? { sessions: [], waiting: 0 });
}
