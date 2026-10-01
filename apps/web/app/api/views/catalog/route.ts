import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { editorCatalog } from '@/lib/views/editor-server';
import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

/**
 * Las fuentes que el lienzo ofrece en sus menús: tablas del espacio, fuentes
 * de la plataforma y las tablas del Feed de QUIEN EDITA (ver
 * lib/views/editor-server.ts). `viewId` sólo sirve para conservar, sin
 * abrirlas, las tablas del Feed ajenas que la vista ya usaba.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const user = await requireSession();
  const viewId = z.string().uuid().safeParse(req.nextUrl.searchParams.get('viewId'));
  const db = getOrgScopedClient(user.organization.id);
  try {
    const catalog = await editorCatalog(db, user.id, viewId.success ? viewId.data : null);
    return NextResponse.json(catalog, { headers: { 'cache-control': 'no-store' } });
  } catch {
    return NextResponse.json(
      { error: 'No se pudieron leer las tablas. Vuelve a intentarlo.' },
      { status: 503 },
    );
  }
}
