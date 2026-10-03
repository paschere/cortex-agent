import { ProductDetail } from '@/components/inventory/ProductDetail';
import { loadProductDetail } from '@/lib/inventory/read';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { bogotaToday } from '@cortex/agent-tools';
import { notFound } from 'next/navigation';
import { recordProductMove, updateProductSettings } from '../actions';

/** La ficha de un producto (0183): existencias, consumo, movimientos y reposición. */

export const dynamic = 'force-dynamic';

export default async function ProductPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  const view = await loadProductDetail(db, id, bogotaToday());
  if (!view) notFound();
  return (
    <ProductDetail
      view={view}
      handlers={{ move: recordProductMove, saveSettings: updateProductSettings }}
    />
  );
}
