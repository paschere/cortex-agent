import { logoResponse, readLogo } from '@/lib/branding/store';
import { openPublicQuote } from '@/lib/sales/public';
import type { NextRequest } from 'next/server';

/**
 * El logo de la empresa dueña de una cotización compartida (0182 + 0170). Con
 * el token de la cotización se lee el logo de ESA empresa, por la ruta que
 * guarda su propia fila de marca: no hay forma de pedir otro archivo.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get('token') ?? '';
  const opened = token ? await openPublicQuote(token) : null;
  if (!opened)
    return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
  return logoResponse(await readLogo(opened.db), req.nextUrl.searchParams.get('v'));
}
