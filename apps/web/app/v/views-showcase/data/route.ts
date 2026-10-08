import { type NextRequest, NextResponse } from 'next/server';
import { SCREEN_KINDS, type ScreenKind, screensView } from '../screens-fixture';

/**
 * Los datos del escaparate de pantallas (`?pantalla=detalle|tarjetas|agenda|tv`),
 * para que abrir un registro y volver funcione de verdad en desarrollo.
 * En producción responde 404, como la página.
 */
export const dynamic = 'force-dynamic';

export function GET(req: NextRequest) {
  if (process.env.NODE_ENV === 'production') return new NextResponse(null, { status: 404 });
  const sp = req.nextUrl.searchParams;
  const kind = sp.get('pantalla') as ScreenKind;
  if (!SCREEN_KINDS.includes(kind))
    return NextResponse.json({ error: 'pantalla' }, { status: 400 });
  return NextResponse.json(
    { view: screensView(kind, { fila: sp.get('fila'), d: sp.get('d') }) },
    { headers: { 'cache-control': 'no-store' } },
  );
}
