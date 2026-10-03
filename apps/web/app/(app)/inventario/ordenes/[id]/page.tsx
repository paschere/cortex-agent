import { PurchaseOrderDetail } from '@/components/inventory/PurchaseOrderDetail';
import { loadPoDetail } from '@/lib/inventory/read';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { notFound } from 'next/navigation';
import {
  approveOrder,
  cancelOrder,
  editOrderLines,
  receiveOrder,
  sendOrder,
  submitOrder,
} from '../../actions';

/** Una orden de compra (0183): del borrador a la factura del proveedor. */

export const dynamic = 'force-dynamic';

export default async function PurchaseOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  const view = await loadPoDetail(db, id, user.id);
  if (!view) notFound();
  return (
    <PurchaseOrderDetail
      view={view}
      handlers={{
        submit: submitOrder,
        approve: approveOrder,
        send: sendOrder,
        receive: receiveOrder,
        cancel: cancelOrder,
        editLines: editOrderLines,
      }}
    />
  );
}
