import { logoResponse, readLogo } from '@/lib/branding/store';
import { openPublicPqrsForm } from '@/lib/compliance/public';
import type { NextRequest } from 'next/server';

/** El logo de la empresa dueña del formulario de PQRS (0195 + 0170), por su token. */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get('token') ?? '';
  const opened = token ? await openPublicPqrsForm(token) : null;
  if (!opened)
    return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
  return logoResponse(await readLogo(opened.db), req.nextUrl.searchParams.get('v'));
}
