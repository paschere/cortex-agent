import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { getView, searchRelationOptions } from '@cortex/agent-tools';
import { NotFoundError, ValidationError } from '@cortex/core';
import { type NextRequest, NextResponse } from 'next/server';

/**
 * Las opciones de un campo de relación de un formulario, con búsqueda, para
 * alguien con sesión. La tabla relacionada sale del esquema (campo `tracker`),
 * no de la petición: `?block=&field=&q=`.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  const view = await getView(db, id);
  if (!view) return NextResponse.json({ error: 'Esa vista ya no existe.' }, { status: 404 });
  const sp = req.nextUrl.searchParams;
  try {
    const options = await searchRelationOptions(db, view, {
      blockId: (sp.get('block') ?? '').slice(0, 40),
      field: (sp.get('field') ?? '').slice(0, 40),
      q: sp.get('q') ?? '',
      audience: 'team',
    });
    return NextResponse.json({ options }, { headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    if (err instanceof NotFoundError || err instanceof ValidationError)
      return NextResponse.json({ error: err.message }, { status: 400 });
    return NextResponse.json({ error: 'No se pudo buscar.' }, { status: 503 });
  }
}
