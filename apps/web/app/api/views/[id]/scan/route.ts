import { isSameOrigin } from '@/lib/activations/request';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { readScanRequest, scanDocument, scanError } from '@/lib/views/scan-doc';
import { getView } from '@cortex/agent-tools';
import { logger } from '@cortex/core';
import { type NextRequest, NextResponse } from 'next/server';

/**
 * «Tomar foto del documento» en el formulario de una vista (ver
 * lib/views/scan-doc.ts): un modelo con visión lee la foto y devuelve
 * sugerencias para los campos. Sólo el equipo con sesión. No guarda nada.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: 'Origen inválido.' }, { status: 403 });
  const { id } = await params;
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  const view = await getView(db, id);
  if (!view) return NextResponse.json({ error: 'Esa vista ya no existe.' }, { status: 404 });
  const read = await readScanRequest(await req.formData().catch(() => null));
  if ('error' in read) return NextResponse.json({ error: read.error }, { status: read.status });
  try {
    const out = await scanDocument({
      db,
      view,
      blockId: read.blockId,
      organizationId: user.organization.id,
      userId: user.id,
      image: read.image,
      signal: req.signal,
    });
    return NextResponse.json(out, { headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    logger.warn({ err, viewId: view.id }, 'views: scan failed');
    return scanError(err);
  }
}
