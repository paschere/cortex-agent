import type { PlanItem } from '../autopilot/types';
import { formatMoneyCop } from './shape';

/**
 * EL PILOTO MIRA EL INVENTARIO (migración 0183) — la parte pura.
 *
 * Cada mañana: lo que hay que reponer, ya descontado lo que viene pedido. Si
 * hay algo con proveedor habitual, UNA pregunta: «X productos bajo el mínimo →
 * N órdenes de compra listas para aprobar». Aprobarla crea las órdenes (una por
 * proveedor) y las deja aprobadas si quien decide administra la empresa; el
 * envío al proveedor sigue siendo otra decisión. Siempre pregunta: una orden de
 * compra compromete plata (efecto `money`). La lectura está en ./autopilot.ts.
 */

export interface SnapshotReorder {
  /** Productos por reponer. */
  count: number;
  /** Cuántos de ellos están bajo el mínimo (el resto se agota antes de reponer). */
  belowMin: number;
  /** Órdenes que saldrían (una por proveedor). */
  orders: number;
  amount: number;
  currency: string;
  /** Productos sin proveedor habitual: no entran a ninguna orden. */
  withoutSupplier: number;
  /** Los que entrarían a las órdenes. */
  productIds: string[];
  suppliers: string[];
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Una clave estable para el MISMO conjunto de productos (no se repregunta). */
function keyOf(ids: readonly string[]): string {
  let h = 0;
  for (const ch of [...ids].sort().join(',')) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return (h >>> 0).toString(36);
}

export function collectReposicion(s: SnapshotReorder | undefined, today: string): PlanItem[] {
  if (!s || s.count === 0) return [];
  const head =
    s.belowMin === s.count
      ? `${plural(s.count, 'producto', 'productos')} bajo el mínimo`
      : `${plural(s.count, 'producto', 'productos')} por reponer`;
  const orphan =
    s.withoutSupplier > 0
      ? ` ${plural(s.withoutSupplier, 'producto no tiene', 'productos no tienen')} proveedor habitual y no entra${s.withoutSupplier === 1 ? '' : 'n'}: fíjalo en Inventario.`
      : '';
  if (s.orders === 0)
    return [
      {
        area: 'pagos',
        title: `${head}, sin proveedor habitual`,
        why: `Hay que reponer, pero no sé a quién pedírselo.${orphan}`,
        proposedAction: null,
        effect: null,
        risk: 'medium',
        dedupeKey: `pagos:reponer:sin-proveedor:${today}`,
        href: '/inventario?tab=reponer',
      },
    ];
  return [
    {
      area: 'pagos',
      title: `${head} → ${plural(s.orders, 'orden de compra lista', 'órdenes de compra listas')} para aprobar`,
      why: `Ya descontado lo que viene pedido: ${s.orders === 1 ? 'una orden' : `${s.orders} órdenes`} (${s.suppliers.slice(0, 3).join(', ')}${s.suppliers.length > 3 ? '…' : ''}) por ${formatMoneyCop(s.amount, s.currency)}. Aprobar crea las órdenes; enviarlas al proveedor es otro clic.${orphan}`,
      proposedAction: {
        toolId: 'purchasing.create_po',
        input: { fromSuggestions: true, productIds: s.productIds.slice(0, 200), approve: true },
      },
      effect: 'money',
      risk: 'medium',
      amount: s.amount,
      currency: s.currency,
      counterparty: s.suppliers[0] ?? null,
      dedupeKey: `pagos:reponer:${keyOf(s.productIds)}`,
      href: '/inventario?tab=reponer',
    },
  ];
}
