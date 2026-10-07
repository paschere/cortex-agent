import { isSameOrigin } from '@/lib/activations/request';
import { formGate, openScreenForApi } from '@/lib/apps/access';
import { voiceTurnsByAppUser } from '@/lib/apps/rate-limit';
import { dictationError } from '@/lib/views/dictate-request';
import { voiceTurn } from '@/lib/views/voice-turn';
import { readVoiceTurn } from '@/lib/views/voice-turn-request';
import { screenView } from '@cortex/agent-tools';
import { logger } from '@cortex/core';
import { type NextRequest, NextResponse } from 'next/server';

/**
 * Un turno del asistente de voz en una pantalla de aplicación (ver
 * lib/views/voice-turn.ts). Las mismas puertas que dictar en la app: la
 * pantalla tiene que ser del rol de quien habla, y en «Ver como…» no se llena
 * nada. No guarda: el envío sigue siendo el del formulario, con sus permisos.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 45;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; screen: string }> },
) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: 'Origen inválido.' }, { status: 403 });
  const { id, screen: screenRef } = await params;
  const opened = await openScreenForApi(id, screenRef, {
    as: req.nextUrl.searchParams.get('como'),
  });
  if (opened instanceof NextResponse) return opened;
  if (opened.readOnly)
    return NextResponse.json({ error: 'En esta vista nada se guarda.' }, { status: 403 });
  const { db, screen } = opened;
  const view = await screenView(db, screen);
  const read = await readVoiceTurn(await req.formData().catch(() => null));
  if ('error' in read) return NextResponse.json({ error: read.error }, { status: 400 });
  const denied = formGate(opened, view, read.blockId);
  if (denied) return denied;
  if (opened.external && !voiceTurnsByAppUser.take(opened.actor.id))
    return NextResponse.json(
      { error: 'Hablaste muchas veces en la última hora. Intenta más tarde.' },
      { status: 429 },
    );
  try {
    return NextResponse.json(await voiceTurn(db, view, read, { signal: req.signal }));
  } catch (err) {
    logger.warn({ err, viewId: view.id }, 'apps: voice turn failed');
    return dictationError(err);
  }
}
