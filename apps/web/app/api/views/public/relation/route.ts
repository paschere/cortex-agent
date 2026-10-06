import { isUnlocked, openPublicView, unlockCookieName } from '@/lib/views/public';
import { searchRelationOptions } from '@cortex/agent-tools';
import { NotFoundError, ValidationError } from '@cortex/core';
import { type NextRequest, NextResponse } from 'next/server';

/**
 * Las opciones de un campo de relación para quien llena un formulario por el
 * enlace público. Mismas puertas que la página (token abierto, contraseña si
 * la pide) y una más: la tabla relacionada tiene que ser una fuente de la
 * MISMA vista (`searchRelationOptions` con `audience: 'public'`); el resto del
 * espacio no se lee. Sólo id y nombre de la fila. `?token=&block=&field=&q=`.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const opened = await openPublicView(sp.get('token') ?? '');
  if (!opened)
    return NextResponse.json({ error: 'Este enlace ya no está disponible.' }, { status: 404 });
  const { view, db } = opened;
  if (
    view.visibility === 'password' &&
    !(await isUnlocked(db, view.id, req.cookies.get(unlockCookieName(view.id))?.value))
  )
    return NextResponse.json({ error: 'Vuelve a escribir la contraseña.' }, { status: 401 });
  try {
    const options = await searchRelationOptions(db, view, {
      blockId: (sp.get('block') ?? '').slice(0, 40),
      field: (sp.get('field') ?? '').slice(0, 40),
      q: sp.get('q') ?? '',
      audience: 'public',
    });
    return NextResponse.json(
      { options },
      { headers: { 'cache-control': 'no-store', 'x-robots-tag': 'noindex' } },
    );
  } catch (err) {
    if (err instanceof NotFoundError || err instanceof ValidationError)
      return NextResponse.json({ error: err.message }, { status: 400 });
    return NextResponse.json({ error: 'No se pudo buscar.' }, { status: 503 });
  }
}
