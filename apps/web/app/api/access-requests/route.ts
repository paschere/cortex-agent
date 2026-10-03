import { parseAccessRequest } from '@/lib/billing/access-request-shape';
import { createAccessRequest } from '@/lib/billing/access-requests';
import { signupMode } from '@/lib/billing/config';
import { logger } from '@cortex/core';
import { type NextRequest, NextResponse } from 'next/server';

/**
 * POST /api/access-requests — guarda una solicitud de «Pide tu acceso».
 *
 * Público (PUBLIC_PATHS): quien pide acceso no tiene cuenta. Sólo existe con
 * SIGNUP_MODE=request; en cualquier otro modo responde 404, para que el
 * endpoint no acumule filas que nadie va a revisar.
 *
 * Contra el abuso: trampa para robots (`website`), cuerpo pequeño, una
 * solicitud pendiente por correo (índice de la 0187), y la misma respuesta
 * tanto si el correo ya había pedido como si no.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  if (signupMode() !== 'request') {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  const raw = await req.text();
  if (raw.length > 8_000) {
    return NextResponse.json({ error: 'Mensaje demasiado largo.' }, { status: 413 });
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: 'No se pudo leer la solicitud.' }, { status: 400 });
  }
  const parsed = parseAccessRequest(body);
  if (parsed.ok === 'trap') return NextResponse.json({ ok: true });
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  try {
    await createAccessRequest(parsed.value);
  } catch (err) {
    logger.error('access-requests: no se pudo guardar', {
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { error: 'No se pudo guardar tu solicitud. Inténtalo de nuevo en un momento.' },
      { status: 500 },
    );
  }
  return NextResponse.json({ ok: true });
}
