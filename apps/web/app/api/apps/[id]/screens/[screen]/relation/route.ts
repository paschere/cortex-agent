import { openScreenForApi, previewAttributesOf } from '@/lib/apps/access';
import { screenView, searchRelationOptions } from '@cortex/agent-tools';
import { NotFoundError, ValidationError } from '@cortex/core';
import { type NextRequest, NextResponse } from 'next/server';

/**
 * Las opciones de un campo de relación de un formulario de una pantalla de
 * aplicación, con búsqueda. La tabla relacionada sale del esquema, no de la
 * petición: `?block=&field=&q=`.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; screen: string }> },
) {
  const { id, screen: screenRef } = await params;
  const sp = req.nextUrl.searchParams;
  const opened = await openScreenForApi(id, screenRef, {
    as: sp.get('como'),
    attributes: previewAttributesOf(sp.getAll('atr')),
  });
  if (opened instanceof NextResponse) return opened;
  const { db, screen, access } = opened;
  const view = await screenView(db, screen);
  try {
    const options = await searchRelationOptions(db, view, {
      blockId: (sp.get('block') ?? '').slice(0, 40),
      field: (sp.get('field') ?? '').slice(0, 40),
      q: sp.get('q') ?? '',
      // Quien no administra sólo ve las tablas que la pantalla ya comparte.
      audience: access.role.admin ? 'team' : 'public',
    });
    return NextResponse.json({ options }, { headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    if (err instanceof NotFoundError || err instanceof ValidationError)
      return NextResponse.json({ error: err.message }, { status: 400 });
    return NextResponse.json({ error: 'No se pudo buscar.' }, { status: 503 });
  }
}
