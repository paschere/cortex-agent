import { isSameOrigin } from '@/lib/activations/request';
import { openScreenForApi } from '@/lib/apps/access';
import { readUploadForm, storeViewUpload, uploadError } from '@/lib/views/upload';
import { screenView } from '@cortex/agent-tools';
import { logger } from '@cortex/core';
import { type NextRequest, NextResponse } from 'next/server';

/**
 * Subir un archivo al campo `file` de un formulario de una pantalla de
 * aplicación (ver lib/views/upload.ts). En «Ver como…» no se escribe nada.
 * Multipart: blockId, field, file. Devuelve {url, name, mime, size}.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

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
  const read = await readUploadForm(await req.formData().catch(() => null));
  if ('error' in read) return NextResponse.json({ error: read.error }, { status: 400 });
  try {
    return NextResponse.json(await storeViewUpload(db, view, read, { publicLink: false }));
  } catch (err) {
    logger.warn({ err, viewId: view.id }, 'apps: upload failed');
    return uploadError(err);
  }
}
