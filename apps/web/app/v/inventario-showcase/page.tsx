import { parseTab } from '@/lib/inventory/shape';
import {
  countRows,
  inventoryTiles,
  locationViews,
  poDetail,
  poListItem,
  productColumns,
  productDetail,
  productPresets,
  productRow,
  reorderGroups,
} from '@/lib/inventory/views';
import { notFound } from 'next/navigation';
import { InventarioFixture } from './Showcase';
import {
  LOCATIONS,
  ORDERS,
  SUPPLIERS,
  fixtureMovements,
  fixtureOverview,
  fixturePlan,
} from './data';

/**
 * INVENTARIO CON DATOS INVENTADOS. SÓLO EN DESARROLLO.
 *
 * /inventario pide sesión; aquí se pintan los mismos componentes
 * (components/inventory) con los datos de una ferretería, armados con las
 * mismas funciones de lib/inventory/views.ts y el motor de verdad.
 *
 * Parámetros: `?tab=productos|reponer|ordenes|bodegas|conteo`,
 * `?pantalla=producto|orden` (`&orden=po13`), `?modo=oscuro`, `?vacia=1`.
 *
 * En producción responde 404: no es una página del producto.
 */
export const dynamic = 'force-dynamic';

export default async function InventarioShowcasePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (process.env.NODE_ENV === 'production') notFound();
  const q = await searchParams;
  const one = (k: string) => (typeof q[k] === 'string' ? (q[k] as string) : null);
  const overview = fixtureOverview(one('vacia') === '1');
  const plan = fixturePlan(overview);
  const units = new Map(overview.products.map((p) => [p.id, p.unit]));
  const first = overview.products[0];
  const { movements, consumption } = fixtureMovements('p1');
  const order = ORDERS.find((o) => o.id === (one('orden') ?? 'po13')) ?? ORDERS[1];
  const names = new Map([
    ['u1', 'Laura Gómez'],
    ['u2', 'Andrés Ríos'],
  ]);
  return (
    <InventarioFixture
      dark={one('modo') === 'oscuro'}
      pantalla={
        one('pantalla') === 'producto'
          ? 'producto'
          : one('pantalla') === 'orden'
            ? 'orden'
            : 'lista'
      }
      screen={{
        tab: parseTab(one('tab')),
        tiles: inventoryTiles(overview, ORDERS, plan.suggestions.length),
        columns: productColumns(SUPPLIERS),
        rows: overview.products.map(productRow),
        presets: productPresets(),
        reorder: reorderGroups(plan, units),
        orders: ORDERS.map(poListItem),
        locations: locationViews(overview),
        count: countRows(overview),
        counts: {
          productos: overview.products.length,
          reponer: plan.suggestions.length,
          ordenes: ORDERS.filter((o) => !['cerrada', 'cancelada', 'facturada'].includes(o.status))
            .length,
        },
      }}
      product={
        first ? productDetail(first, { movements, consumption, locations: LOCATIONS }) : null
      }
      order={order ? poDetail(order, { locations: LOCATIONS, canApprove: true, names }) : null}
    />
  );
}
