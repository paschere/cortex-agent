import { requireSession } from '@/lib/session';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

/**
 * Las llamadas en curso del espacio de trabajo — lo que lista la pestaña
 * «Llamadas». El bot guarda las sesiones en memoria y las olvida 30 s después
 * de que terminan, así que esto es una foto de lo que está pasando AHORA, no
 * un archivo: lo pasado vive en los transcripts guardados.
 *
 * `configured: false` distingue «no hay llamadas» de «el bot no está
 * conectado», para que la pantalla no prometa algo que no puede hacer.
 */
export async function GET() {
  const user = await requireSession();
  const base = process.env.MEET_SERVICE_URL?.replace(/\/+$/, '');
  const token = process.env.MEET_SERVICE_TOKEN;
  if (!base || !token) {
    return NextResponse.json(
      { configured: false, meetings: [] },
      { headers: { 'cache-control': 'no-store' } },
    );
  }
  const upstream = await fetch(`${base}/live?owner=${encodeURIComponent(user.organization.id)}`, {
    headers: { authorization: `Bearer ${token}` },
    cache: 'no-store',
    signal: AbortSignal.timeout(8_000),
  }).catch(() => null);
  if (!upstream || !upstream.ok) {
    return NextResponse.json(
      { configured: true, reachable: false, meetings: [] },
      { headers: { 'cache-control': 'no-store' } },
    );
  }
  const data = (await upstream.json()) as { meetings?: unknown[] };
  return NextResponse.json(
    { configured: true, reachable: true, meetings: data.meetings ?? [] },
    { headers: { 'cache-control': 'no-store' } },
  );
}
