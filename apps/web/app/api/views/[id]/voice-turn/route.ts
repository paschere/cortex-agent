import { isSameOrigin } from '@/lib/activations/request';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { dictationError } from '@/lib/views/dictate-request';
import { voiceTurn } from '@/lib/views/voice-turn';
import { readVoiceTurn } from '@/lib/views/voice-turn-request';
import { getView } from '@cortex/agent-tools';
import { logger } from '@cortex/core';
import { type NextRequest, NextResponse } from 'next/server';

/**
 * Un turno del asistente de voz dentro de la app (ver lib/views/voice-turn.ts).
 * Las mismas puertas que dictar: sesión y una vista de la empresa (otra
 * empresa es un 404). No guarda nada.
 */

export const runtime = 'nodejs';
export const maxDuration = 45;

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: 'Origen inválido.' }, { status: 403 });
  const { id } = await params;
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  const view = await getView(db, id);
  if (!view) return NextResponse.json({ error: 'Esa vista ya no existe.' }, { status: 404 });
  const read = await readVoiceTurn(await req.formData().catch(() => null));
  if ('error' in read) return NextResponse.json({ error: read.error }, { status: 400 });
  try {
    return NextResponse.json(await voiceTurn(db, view, read, { signal: req.signal }));
  } catch (err) {
    logger.warn({ err, viewId: view.id }, 'views: voice turn failed');
    return dictationError(err);
  }
}
