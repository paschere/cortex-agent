import { isSameOrigin } from '@/lib/activations/request';
import { openScreenForApi } from '@/lib/apps/access';
import { autofillForForm } from '@/lib/trackers/autofill-view';
import { screenView } from '@cortex/agent-tools';
import { type NextRequest, NextResponse } from 'next/server';

/**
 * «Llenar con Cortex» en una pantalla de aplicación. Sólo para el equipo con
 * sesión: quien abre la app desde un enlace externo no gasta búsquedas de la
 * empresa. No guarda nada.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

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
    return NextResponse.json({ error: 'Aquí Cortex no llena por ti.' }, { status: 403 });
  const view = await screenView(opened.db, opened.screen);
  return autofillForForm({
    db: opened.db,
    view,
    organizationId: opened.actor.organizationId,
    userId: opened.actor.id,
    body: await req.json().catch(() => null),
    signal: req.signal,
  });
}
