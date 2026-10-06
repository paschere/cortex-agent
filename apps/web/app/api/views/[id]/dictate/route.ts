import { isSameOrigin } from '@/lib/activations/request';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { dictateForm } from '@/lib/views/dictate';
import { dictationError, readDictation } from '@/lib/views/dictate-request';
import { getView } from '@cortex/agent-tools';
import { logger } from '@cortex/core';
import { type NextRequest, NextResponse } from 'next/server';

/**
 * Dictar un registro en el formulario de una vista, dentro de la app (ver
 * lib/views/dictate.ts). Una vista de otra empresa es un 404, como en /data.
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
  const read = await readDictation(await req.formData().catch(() => null));
  if ('error' in read) return NextResponse.json({ error: read.error }, { status: 400 });
  try {
    return NextResponse.json(
      await dictateForm(db, view, read.blockId, read.input, { signal: req.signal }),
    );
  } catch (err) {
    logger.warn({ err, viewId: view.id }, 'views: dictation failed');
    return dictationError(err);
  }
}
