import { isSameOrigin } from '@/lib/activations/request';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { readUploadForm, storeViewUpload, uploadError } from '@/lib/views/upload';
import { getView } from '@cortex/agent-tools';
import { logger } from '@cortex/core';
import { type NextRequest, NextResponse } from 'next/server';

/**
 * Subir un archivo al campo `file` de un formulario de vista, dentro de la app
 * (ver lib/views/upload.ts). Una vista de otra empresa es un 404.
 * Multipart: blockId, field, file. Devuelve {url, name, mime, size}.
 */

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: 'Origen inválido.' }, { status: 403 });
  const { id } = await params;
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  const view = await getView(db, id);
  if (!view) return NextResponse.json({ error: 'Esa vista ya no existe.' }, { status: 404 });
  const read = await readUploadForm(await req.formData().catch(() => null));
  if ('error' in read) return NextResponse.json({ error: read.error }, { status: 400 });
  try {
    return NextResponse.json(await storeViewUpload(db, view, read, { publicLink: false }));
  } catch (err) {
    logger.warn({ err, viewId: view.id }, 'views: upload failed');
    return uploadError(err);
  }
}
