import { isUnlocked, openPublicView, unlockCookieName } from '@/lib/views/public';
import {
  canWriteView,
  computeView,
  loadViewSources,
  parseViewFilterParam,
} from '@cortex/agent-tools';
import { type NextRequest, NextResponse } from 'next/server';

/**
 * El refresco en vivo de una vista compartida. Mismas puertas que la página:
 * token abierto, contraseña si la pide (cookie de desbloqueo), y las fuentes
 * internas no se leen (`audience: 'public'`). Sin contar una visita: refrescar
 * no es abrir.
 *
 * `?f=` (la barra de filtros) se valida contra el spec guardado, y
 * `audience: 'public'` también en el cálculo: sin `detailFields` en el spec,
 * la ficha de una fila sólo trae lo que el bloque ya muestra.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get('token') ?? '';
  const opened = await openPublicView(token);
  if (!opened)
    return NextResponse.json({ error: 'Este enlace ya no está disponible.' }, { status: 404 });
  const { view, db } = opened;
  if (
    view.visibility === 'password' &&
    !(await isUnlocked(db, view.id, req.cookies.get(unlockCookieName(view.id))?.value))
  )
    return NextResponse.json({ error: 'Vuelve a escribir la contraseña.' }, { status: 401 });
  const computed = computeView(
    view.spec,
    await loadViewSources(db, view.spec, { audience: 'public' }),
    new Date(),
    {
      writable: canWriteView(view, 'public'),
      audience: 'public',
      filters: parseViewFilterParam(view.spec, req.nextUrl.searchParams.get('f')),
    },
  );
  return NextResponse.json(
    { version: view.version, view: computed },
    { headers: { 'cache-control': 'no-store', 'x-robots-tag': 'noindex' } },
  );
}
