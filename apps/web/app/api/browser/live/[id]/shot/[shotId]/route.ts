import { requireSession } from '@/lib/session';
import { browserActorKey } from '@cortex/agent-tools/src/browser/profiles';
import { logger } from '@cortex/core';
import { type NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const maxDuration = 15;

/**
 * La foto chica de un paso de la computadora de Cortex.
 *
 * Los bytes viven en el servicio de navegador (services/browser/src/shots.ts);
 * el resultado de la herramienta sólo lleva esta ruta. Aquí entra la cookie de
 * la persona, sale la imagen, y el servicio vuelve a comprobar que la pestaña
 * era suya (contesta 404 a cualquier otro dueño, igual que si no existiera).
 * Privada y `immutable`: un id de foto no se reutiliza.
 */
const ID = /^[A-Za-z0-9_-]{1,64}$/;

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string; shotId: string }> },
) {
  const session = await requireSession();
  const { id, shotId } = await ctx.params;
  if (!ID.test(id) || !ID.test(shotId)) {
    return NextResponse.json({ error: 'Foto no válida.' }, { status: 400 });
  }
  const base = process.env.BROWSER_SERVICE_URL?.replace(/\/+$/, '');
  const token = process.env.BROWSER_SERVICE_TOKEN;
  if (!base || !token) {
    return NextResponse.json(
      { error: 'El servicio de navegador no está configurado.' },
      { status: 503 },
    );
  }
  try {
    const response = await fetch(
      `${base}/session/${encodeURIComponent(id)}/shot/${encodeURIComponent(shotId)}`,
      {
        headers: {
          authorization: `Bearer ${token}`,
          'x-cortex-owner': browserActorKey(session.organization.id, session.id),
        },
        signal: AbortSignal.timeout(8_000),
      },
    );
    if (!response.ok) {
      return NextResponse.json({ error: 'Esa foto ya no está.' }, { status: 404 });
    }
    return new NextResponse(await response.arrayBuffer(), {
      status: 200,
      headers: {
        'content-type': 'image/jpeg',
        'cache-control': 'private, max-age=21600, immutable',
      },
    });
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'shot proxy failed');
    return NextResponse.json({ error: 'No pude traer la foto.' }, { status: 502 });
  }
}
