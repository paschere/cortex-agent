import { logoResponse, readLogo } from '@/lib/branding/store';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import type { NextRequest } from 'next/server';

/**
 * El logo de la empresa de la sesión (migración 0170), para las vistas de
 * adentro y la pantalla de la marca. La ruta del archivo sale de la fila de
 * ESTA empresa, leída con su handle: no hay parámetro que nombre otro logo.
 * `?v=` es la huella del contenido; con la correcta, el navegador lo guarda.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  return logoResponse(await readLogo(db), req.nextUrl.searchParams.get('v'));
}
