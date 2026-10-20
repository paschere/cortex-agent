import { isSameOrigin } from '@/lib/activations/request';
import { formGate, openScreenForApi } from '@/lib/apps/access';
import { readScanRequest, scanDocument, scanError } from '@/lib/views/scan-doc';
import { screenView } from '@cortex/agent-tools';
import { logger } from '@cortex/core';
import { type NextRequest, NextResponse } from 'next/server';

/**
 * «Tomar foto del documento» en el formulario de una pantalla de aplicación.
 * Sólo el equipo con sesión (quien entra por un enlace externo no gasta lecturas
 * de la empresa) y sólo si su rol registra en la tabla del formulario. No guarda
 * nada: devuelve sugerencias.
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
  if (opened.readOnly || opened.external)
    return NextResponse.json({ error: 'Aquí Cortex no lee fotos por ti.' }, { status: 403 });
  const { db, screen } = opened;
  const view = await screenView(db, screen);
  const read = await readScanRequest(await req.formData().catch(() => null));
  if ('error' in read) return NextResponse.json({ error: read.error }, { status: read.status });
  const denied = formGate(opened, view, read.blockId);
  if (denied) return denied;
  try {
    const out = await scanDocument({
      db,
      view,
      blockId: read.blockId,
      organizationId: opened.actor.organizationId,
      userId: opened.actor.id,
      image: read.image,
      signal: req.signal,
    });
    return NextResponse.json(out, { headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    logger.warn({ err, viewId: view.id }, 'apps: scan failed');
    return scanError(err);
  }
}
