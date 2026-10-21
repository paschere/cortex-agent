import { isSameOrigin } from '@/lib/activations/request';
import { openScreenForApi } from '@/lib/apps/access';
import { checkAppDuplicates, screenView } from '@cortex/agent-tools';
import { NotFoundError, ValidationError } from '@cortex/core';
import { type NextRequest, NextResponse } from 'next/server';

/**
 * «Parece que ya existe»: la verificación previa de un formulario de una
 * pantalla de aplicación. Sólo mira filas que el rol puede ver y sólo avisa;
 * no guarda nada. Una verificación que falla nunca estorba al formulario: el
 * navegador la trata como «sin coincidencias».
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

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
  const body = (await req.json().catch(() => null)) as {
    block?: unknown;
    values?: unknown;
  } | null;
  const values =
    body?.values && typeof body.values === 'object' && !Array.isArray(body.values)
      ? (body.values as Record<string, unknown>)
      : {};
  try {
    const view = await screenView(opened.db, opened.screen);
    const out = await checkAppDuplicates(opened.db, opened.access, view, {
      blockId: String(body?.block ?? '').slice(0, 40),
      values,
    });
    return NextResponse.json(out, { headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    if (err instanceof NotFoundError || err instanceof ValidationError)
      return NextResponse.json({ keys: [], matches: [], openIn: null });
    return NextResponse.json({ keys: [], matches: [], openIn: null }, { status: 503 });
  }
}
