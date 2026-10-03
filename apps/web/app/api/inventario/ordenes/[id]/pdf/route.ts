import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import {
  bogotaToday,
  getPurchaseOrder,
  loadPoBrand,
  purchaseOrderFilename,
  renderPurchaseOrderPdf,
} from '@cortex/agent-tools';

/**
 * El PDF de una orden de compra (0183), con la marca de la empresa de la
 * sesión. La orden se lee con el handle de ESA empresa: un id ajeno es 404.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  const po = await getPurchaseOrder(db, id);
  if (!po)
    return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
  let locationName: string | null = null;
  if (po.locationId) {
    const { data, error } = await db
      .from('stock_locations')
      .select('name')
      .eq('id', po.locationId)
      .maybeSingle();
    if (!error) locationName = (data as { name: string } | null)?.name ?? null;
  }
  const brand = await loadPoBrand(db, user.organization.id);
  const pdf = renderPurchaseOrderPdf(po, brand, {
    issuedOn: (po.approvedAt ?? po.createdAt ?? bogotaToday()).slice(0, 10),
    locationName,
  });
  return new Response(new Uint8Array(pdf), {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${purchaseOrderFilename(po)}"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
