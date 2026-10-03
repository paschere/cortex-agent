import { InventoryScreen } from '@/components/inventory/InventoryScreen';
import { loadInventoryData } from '@/lib/inventory/read';
import { parseTab } from '@/lib/inventory/shape';
import {
  countRows,
  inventoryTiles,
  locationViews,
  poListItem,
  productColumns,
  productPresets,
  productRow,
  reorderGroups,
} from '@/lib/inventory/views';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { bogotaToday } from '@cortex/agent-tools';
import {
  addLocation,
  applyCount,
  bulkEditProducts,
  createOrdersFromReorder,
  createProductRow,
  editProductCell,
  importProductsCsv,
  setPreferredSupplier,
} from './actions';

/**
 * Inventario y compras (migración 0183): productos con existencias y alertas,
 * lo que hay que reponer con las órdenes a un clic, las órdenes de compra, las
 * bodegas y el conteo físico.
 */

export const dynamic = 'force-dynamic';

export default async function InventoryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const q = await searchParams;
  const tab = parseTab(q.tab);
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  const data = await loadInventoryData(db, bogotaToday());
  const units = new Map(data.overview.products.map((p) => [p.id, p.unit]));
  const open = data.orders.filter((o) => !['cerrada', 'cancelada', 'facturada'].includes(o.status));

  return (
    <InventoryScreen
      tab={tab}
      tiles={inventoryTiles(data.overview, data.orders, data.plan.suggestions.length)}
      columns={productColumns(data.suppliers)}
      rows={data.overview.products.map(productRow)}
      presets={productPresets()}
      reorder={reorderGroups(data.plan, units)}
      orders={data.orders.map(poListItem)}
      locations={locationViews(data.overview)}
      count={countRows(data.overview)}
      counts={{
        productos: data.overview.products.length,
        reponer: data.plan.suggestions.length,
        ordenes: open.length,
      }}
      handlers={{
        onEdit: editProductCell,
        onBulkEdit: bulkEditProducts,
        onCreate: createProductRow,
        importCsv: importProductsCsv,
        createOrders: createOrdersFromReorder,
        setSupplier: setPreferredSupplier,
        addLocation,
        applyCount,
      }}
    />
  );
}
