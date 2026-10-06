import { isSameOrigin } from '@/lib/activations/request';
import { isUnlocked, openPublicView, unlockCookieName } from '@/lib/views/public';
import { readUploadForm, storeViewUpload, uploadError } from '@/lib/views/upload';
import { logger } from '@cortex/core';
import { type NextRequest, NextResponse } from 'next/server';

/**
 * Subir un archivo al formulario de una vista compartida. Las mismas puertas
 * que enviar el formulario: token válido y, si la vista pide contraseña, la
 * cookie de desbloqueo. Multipart: token, blockId, field, file. Con tope de
 * subidas por hora por vista (lib/views/upload.ts).
 */

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: 'Origen inválido.' }, { status: 403 });
  const form = await req.formData().catch(() => null);
  const token = String(form?.get('token') ?? '');
  if (token.length < 32 || token.length > 64)
    return NextResponse.json({ error: 'Este enlace ya no está disponible.' }, { status: 404 });
  const read = await readUploadForm(form);
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
    return NextResponse.json(await storeViewUpload(db, view, read, { publicLink: true }));
  } catch (err) {
    logger.warn({ err, viewId: view.id }, 'views: public upload failed');
    return uploadError(err);
  }
}
