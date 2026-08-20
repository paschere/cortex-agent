import { requireSession } from '@/lib/session';
import { logger } from '@cortex/core';
import { type NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const maxDuration = 30;

/**
 * El pase de un minuto para la pantalla en vivo.
 *
 * Vercel no termina WebSockets, así que el navegador de la persona se conecta
 * DIRECTO al servicio de navegador en Railway. Esta ruta es el intercambio de
 * credenciales que lo hace posible sin regalar nada: entra una sesión de
 * Cortex (cookie), sale un boleto HMAC que abre UNA sesión de navegador
 * durante UN minuto (services/browser/src/stream-token.ts lleva el esquema).
 *
 * Si `BROWSER_SERVICE_PUBLIC_URL` no está puesta se deriva de la interna —
 * que en Railway suele ser la misma URL pública. Si el servicio no es
 * alcanzable desde el navegador de la persona, el WebSocket simplemente no
 * conecta y la tarjeta se queda en su respaldo de fotos por segundo, que es
 * exactamente el comportamiento correcto de un extra que falla.
 */
export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  const { id } = await ctx.params;

  const base = process.env.BROWSER_SERVICE_URL?.replace(/\/+$/, '');
  const token = process.env.BROWSER_SERVICE_TOKEN;
  if (!base || !token) {
    return NextResponse.json(
      { error: 'El servicio de navegador no está configurado.' },
      { status: 503 },
    );
  }

  const sid = encodeURIComponent(id);
  let ticket: string;
  try {
    const response = await fetch(`${base}/session/${sid}/stream-token`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        'x-cortex-owner': session.organization.id,
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      return NextResponse.json(
        { error: 'Esa pestaña ya se cerró.' },
        { status: response.status === 404 ? 410 : 502 },
      );
    }
    ticket = ((await response.json()) as { token: string }).token;
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'stream token request failed');
    return NextResponse.json(
      { error: 'No pude comunicarme con el servicio de navegador.' },
      { status: 502 },
    );
  }

  const publicBase = (process.env.BROWSER_SERVICE_PUBLIC_URL ?? base).replace(/\/+$/, '');
  const wsBase = publicBase.replace(/^http/, 'ws');
  return NextResponse.json({
    wsUrl: `${wsBase}/session/${sid}/stream?token=${encodeURIComponent(ticket)}`,
  });
}
