import { applyVerifiedEvent } from '@/lib/billing/webhook';
import { wompiFromEnv } from '@/lib/billing/wompi';
import { logger } from '@cortex/core';
import { type NextRequest, NextResponse } from 'next/server';

/**
 * POST /api/billing/wompi/webhook — los avisos de eventos de Wompi.
 *
 * Público (PUBLIC_PATHS en middleware.ts): Wompi no tiene cookie. La
 * credencial es la firma: SHA256 de las propiedades que el aviso nombra, su
 * `timestamp` y WOMPI_EVENTS_SECRET (lib/billing/wompi.ts). Sin firma válida,
 * 401 y no se lee nada de la base.
 *
 * Respuestas:
 *   503  la pasarela no está configurada (Wompi reintenta, que es lo correcto).
 *   401  firma inválida.
 *   200  todo lo demás, incluido un aviso repetido o de una referencia que no es
 *        nuestra: reintentar no cambiaría nada.
 *   500  falló la base: Wompi reintenta a los 30 min, 3 h y 24 h, y como todo
 *        es idempotente por evento, el reintento termina el trabajo.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BODY_BYTES = 64 * 1024;

export async function POST(req: NextRequest) {
  const { provider, reason } = wompiFromEnv();
  if (!provider) {
    logger.warn('billing: aviso de Wompi sin pasarela configurada', { reason });
    return NextResponse.json({ error: 'not_configured' }, { status: 503 });
  }

  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'too_large' }, { status: 413 });
  }
  if (!provider.verifyWebhook(raw, req.headers)) {
    logger.warn('billing: aviso de Wompi con firma inválida');
    return NextResponse.json({ error: 'invalid_signature' }, { status: 401 });
  }

  const event = provider.parseEvent(raw);
  if (!event) return NextResponse.json({ ok: true, ignored: true });

  try {
    const outcome = await applyVerifiedEvent(event, 'wompi');
    return NextResponse.json({ ok: true, outcome });
  } catch (err) {
    logger.error('billing: no se pudo aplicar el aviso de Wompi', {
      reference: event.reference,
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: 'apply_failed' }, { status: 500 });
  }
}
