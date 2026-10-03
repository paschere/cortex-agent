import { logoResponse, readLogo } from '@/lib/branding/store';
import { openPublicSurvey } from '@/lib/crm/public';
import type { NextRequest } from 'next/server';

/**
 * El logo de la empresa dueña de una encuesta (0193 + 0170). Con el token de
 * la encuesta se lee el logo de ESA empresa: no hay forma de pedir otro.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get('token') ?? '';
  const opened = token ? await openPublicSurvey(token) : null;
  if (!opened)
    return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
  return logoResponse(await readLogo(opened.db), req.nextUrl.searchParams.get('v'));
}
