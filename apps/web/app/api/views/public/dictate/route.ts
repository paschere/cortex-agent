import { isSameOrigin } from '@/lib/activations/request';
import { dictateForm } from '@/lib/views/dictate';
import { dictationError, readDictation } from '@/lib/views/dictate-request';
import { isUnlocked, openPublicView, unlockCookieName } from '@/lib/views/public';
import { logger } from '@cortex/core';
import { type NextRequest, NextResponse } from 'next/server';

/**
 * Dictar un registro en el formulario de una vista compartida (ver
 * lib/views/dictate.ts). Las mismas puertas que enviar el formulario: token
 * válido y, si la vista pide contraseña, la cookie de desbloqueo. No guarda
 * nada: devuelve los valores para que la persona los revise y envíe.
 */

export const runtime = 'nodejs';
export const maxDuration = 45;

export async function POST(req: NextRequest) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: 'Origen inválido.' }, { status: 403 });
  const form = await req.formData().catch(() => null);
  const token = String(form?.get('token') ?? '');
  if (token.length < 32 || token.length > 64)
    return NextResponse.json({ error: 'Este enlace ya no está disponible.' }, { status: 404 });
  const read = await readDictation(form);
  if ('error' in read) return NextResponse.json({ error: read.error }, { status: 400 });

  const opened = await openPublicView(token);
  if (!opened)
    return NextResponse.json({ error: 'Este enlace ya no está disponible.' }, { status: 404 });
  const { view, db } = opened;
  if (
    view.visibility === 'password' &&
    !(await isUnlocked(db, view.id, req.cookies.get(unlockCookieName(view.id))?.value))
  )
    return NextResponse.json(
      { error: 'Vuelve a escribir la contraseña de la vista.' },
      { status: 401 },
    );

  try {
    return NextResponse.json(
      await dictateForm(db, view, read.blockId, read.input, { signal: req.signal }),
    );
  } catch (err) {
    logger.warn({ err, viewId: view.id }, 'views: public dictation failed');
    return dictationError(err);
  }
}
