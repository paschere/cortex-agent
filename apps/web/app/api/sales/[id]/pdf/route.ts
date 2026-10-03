import { salesPdfResponse } from '@/lib/sales/pdf';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { getSalesDocumentRow } from '@cortex/agent-tools';
import type { NextRequest } from 'next/server';

/** El PDF de un documento de venta, para el equipo (con sesión). */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireSession().catch(() => null);
  if (!user) return new Response('Unauthorized', { status: 401 });
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new Response('Not found', { status: 404 });
  const db = getOrgScopedClient(user.organization.id);
  const doc = await getSalesDocumentRow(db, id);
  if (!doc) return new Response('Not found', { status: 404 });
  return salesPdfResponse(db, doc, user.organization.name ?? 'Cortex');
}
