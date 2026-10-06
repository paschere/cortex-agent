import { specForExport, takeExportSlot, workbookResponse } from '@/lib/views/export-response';
import { isUnlocked, openPublicView, unlockCookieName } from '@/lib/views/public';
import { computeView, loadViewSources, parseViewFilterParam } from '@cortex/agent-tools';
import { type NextRequest, NextResponse } from 'next/server';

/**
 * «Exportar → Excel» desde una vista compartida. Exactamente las puertas de
 * /api/views/public/data: token abierto, contraseña si la pide (cookie de
 * desbloqueo) y sólo las fuentes permitidas (`audience: 'public'`: una fuente
 * interna ni se lee, así que ni sus bloques ni sus filas pueden salir en el
 * archivo). Nunca editable: no hay nada que escribir al exportar.
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
  if (!takeExportSlot(`v:${view.id}`))
    return NextResponse.json(
      { error: 'Se exportó esta vista muchas veces en la última hora. Intenta más tarde.' },
      { status: 429 },
    );
  const spec = specForExport(view.spec);
  const computed = computeView(
    spec,
    await loadViewSources(db, spec, { audience: 'public' }),
    new Date(),
    {
      writable: false,
      audience: 'public',
      filters: parseViewFilterParam(view.spec, req.nextUrl.searchParams.get('f')),
    },
  );
  return workbookResponse(computed, view.name, { 'x-robots-tag': 'noindex' });
}
