import { salesPdfResponse } from '@/lib/sales/pdf';
import { openPublicQuote } from '@/lib/sales/public';
import type { NextRequest } from 'next/server';

/**
 * El PDF de una cotización compartida (0182). El token es la credencial, como
 * en la página; uno que no abre es 404.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get('token') ?? '';
  const opened = token ? await openPublicQuote(token) : null;
  if (!opened)
    return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
  return salesPdfResponse(opened.db, opened.doc, opened.organizationName);
}
