import { openScreenForApi } from '@/lib/apps/access';
import { recordAppEvent } from '@cortex/agent-tools';
import { type NextRequest, NextResponse } from 'next/server';

/**
 * Un evento de uso de una pantalla (0225): hoy sólo «empezó a llenar un
 * formulario». Sirve para medir abandonos y el tiempo de llenado. Sin
 * contenido: el bloque y una referencia que se une con el envío. Nunca falla
 * en voz alta: medir no puede estorbar a quien llena el formulario.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; screen: string }> },
) {
  const { id, screen: screenRef } = await params;
  const opened = await openScreenForApi(id, screenRef);
  if (opened instanceof NextResponse) return opened;
  if (opened.readOnly) return NextResponse.json({ ok: true });
  const body = (await req.json().catch(() => ({}))) as { block?: unknown; ref?: unknown };
  const block = typeof body.block === 'string' ? body.block.slice(0, 40) : null;
  const ref = typeof body.ref === 'string' && body.ref.length >= 8 ? body.ref.slice(0, 80) : null;
  if (block && ref)
    await recordAppEvent(opened.db, opened.access, {
      kind: 'form_start',
      screen: opened.screen.slug,
      blockId: block,
      ref,
    });
  return NextResponse.json({ ok: true });
}
