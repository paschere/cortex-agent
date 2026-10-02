import { logoResponse, readLogo } from '@/lib/branding/store';
import { openPublicView } from '@/lib/views/public';
import type { NextRequest } from 'next/server';

/**
 * El logo de la empresa dueña de una vista compartida (migración 0170).
 *
 * El token de la vista es la credencial, igual que en la página: un token que
 * no abre (revocado, vencido, inventado) es 404. Con uno que abre, el logo se
 * lee con el handle de la empresa DE ESA VISTA y por la ruta que guarda su
 * propia fila — no hay forma de pedir el logo de otra empresa con este
 * enlace, ni ningún otro archivo.
 *
 * No pide la contraseña: la cabecera de la vista con contraseña ya muestra el
 * nombre de la empresa antes de desbloquear, y el logo es lo mismo en dibujo.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get('token') ?? '';
  const opened = token ? await openPublicView(token) : null;
  if (!opened)
    return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
  return logoResponse(await readLogo(opened.db), req.nextUrl.searchParams.get('v'));
}
