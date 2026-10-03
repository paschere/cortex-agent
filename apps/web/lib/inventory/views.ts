import type { GridColumn, GridRow, GridView } from '@/components/datagrid/types';
import {
  type InventoryOverview,
  MOVEMENT_KIND_LABEL,
  PO_STATUS_LABEL,
  PO_STATUS_TONE,
  type ProductOverview,
  type PurchaseOrder,
  REFERENCE_KIND_LABEL,
  type ReorderPlan,
  STOCK_ALERT_LABEL,
  STOCK_ALERT_TONE,
  type StockConsumption,
  type StockLocationRow,
  type StockMovementRow,
  type SupplierRef,
} from '@cortex/agent-tools';
import type {
  CountRowView,
  InventoryTile,
  LocationView,
  MovementView,
  PoDetailView,
  PoListItem,
  ProductDetailView,
  ReorderGroupView,
  Tone,
} from './shape';

/**
 * DE LOS DATOS DEL INVENTARIO A LO QUE SE PINTA (0183).
 *
 * Funciones puras que reciben lo que devuelve el paquete (catálogo con
 * existencias, plan de reposición, órdenes) y arman las vistas de
 * lib/inventory/shape.ts. Las usan la página (con datos de la base) y el
 * escaparate de desarrollo (con datos inventados): la misma pantalla en los
 * dos lados. Ningún componente de cliente importa este archivo.
 */

export const INVENTORY_VIEW_SCOPE = 'inventory_products';

export function money(n: number | null | undefined, currency = 'COP'): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  if (currency === 'COP') return `$ ${Math.round(n).toLocaleString('es-CO')}`;
  return `${n.toLocaleString('es-CO', { maximumFractionDigits: 2 })} ${currency}`;
}

export function qty(n: number | null | undefined, unit?: string): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  const text = n.toLocaleString('es-CO', { maximumFractionDigits: 2 });
  return unit ? `${text} ${unit}` : text;
}

const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

export function shortDay(day: string | null | undefined): string {
  if (!day) return '—';
  const [, m, d] = day.slice(0, 10).split('-').map(Number);
  return `${d} ${MONTHS[(m ?? 1) - 1]}`;
}

// ---------------------------------------------------------------------------
// Productos
// ---------------------------------------------------------------------------

const ALERT_OPTIONS: GridColumn['options'] = (
  ['agotado', 'bajo_minimo', 'se_agota', 'sin_movimiento', 'ok'] as const
).map((a) => ({ value: STOCK_ALERT_LABEL[a], tone: STOCK_ALERT_TONE[a] }));

const SOURCE_LABEL: Record<string, string> = {
  manual: 'A mano',
  sheet: 'Hoja',
  siigo: 'Siigo',
  alegra: 'Alegra',
  quickbooks: 'QuickBooks',
};

export function sourceLabel(p: Pick<ProductOverview, 'source' | 'sourceSystem'>): string {
  return SOURCE_LABEL[p.sourceSystem ?? p.source] ?? 'A mano';
}

export function productColumns(suppliers: SupplierRef[]): GridColumn[] {
  return [
    { key: 'codigo', label: 'Código', type: 'text', editable: true, width: 110 },
    {
      key: 'producto',
      label: 'Producto',
      type: 'text',
      editable: true,
      required: true,
      pinned: true,
      primary: true,
      width: 240,
    },
    {
      key: 'alerta',
      label: 'Alerta',
      type: 'status',
      width: 170,
      options: ALERT_OPTIONS,
      description:
        'Agotado, bajo el mínimo, se agota antes de que llegue un pedido, o sin movimiento en 90 días.',
    },
    {
      key: 'existencia',
      label: 'Existencia',
      type: 'number',
      width: 110,
      description: 'Todas las bodegas: la suma del libro de movimientos.',
    },
    { key: 'minimo', label: 'Mínimo', type: 'number', editable: true, width: 100 },
    {
      key: 'reponer',
      label: 'Cant. a pedir',
      type: 'number',
      editable: true,
      width: 120,
      description:
        'Lo que se pide cada vez. Sin ella, Cortex calcula lo que cubre los días de entrega.',
    },
    { key: 'entrega', label: 'Días de entrega', type: 'number', editable: true, width: 120 },
    { key: 'unidad', label: 'Unidad', type: 'text', editable: true, width: 90 },
    {
      key: 'costo',
      label: 'Costo promedio',
      type: 'money',
      width: 130,
      description: 'Costo promedio ponderado: cada entrada con costo lo mueve.',
    },
    { key: 'precio', label: 'Precio de venta', type: 'money', editable: true, width: 130 },
    {
      key: 'valor',
      label: 'Valor',
      type: 'money',
      width: 130,
      description: 'Existencia × costo promedio.',
    },
    {
      key: 'consumo',
      label: 'Consumo/día',
      type: 'number',
      width: 110,
      description: 'Salidas por día en los últimos 90 días.',
    },
    { key: 'alcanza', label: 'Días que alcanza', type: 'number', width: 130 },
    {
      key: 'rotacion',
      label: 'Rotación',
      type: 'number',
      width: 100,
      description: 'Veces al año que se vende lo que hay hoy.',
    },
    {
      key: 'proveedor',
      label: 'Proveedor habitual',
      type: 'select',
      editable: true,
      width: 190,
      options: suppliers.map((s) => ({ value: s.id, label: s.name })),
    },
    { key: 'categoria', label: 'Categoría', type: 'text', editable: true, width: 140 },
    {
      key: 'origen',
      label: 'Origen',
      type: 'select',
      width: 110,
      options: Object.values(SOURCE_LABEL).map((v) => ({ value: v, tone: 'neutral' as const })),
    },
  ];
}

export function productRow(p: ProductOverview): GridRow {
  return {
    id: p.id,
    href: `/inventario/${p.id}`,
    values: {
      codigo: p.sku,
      producto: p.name,
      alerta: STOCK_ALERT_LABEL[p.alert],
      existencia: p.onHand,
      minimo: p.minStock,
      reponer: p.reorderQty,
      entrega: p.leadTimeDays,
      unidad: p.unit,
      costo: p.cost,
      precio: p.price,
      valor: p.value,
      consumo: p.dailyUse ? Math.round(p.dailyUse * 100) / 100 : null,
      alcanza: p.daysOfCover,
      rotacion: p.turnover,
      proveedor: p.preferredSupplierId,
      categoria: p.category,
      origen: sourceLabel(p),
    },
  };
}

/** Sumar mínimos o costos de productos distintos no dice nada: sólo el valor suma. */
const AGGREGATES: GridView['aggregates'] = {
  existencia: 'none',
  minimo: 'none',
  reponer: 'none',
  entrega: 'none',
  costo: 'none',
  precio: 'none',
  valor: 'sum',
  consumo: 'none',
  alcanza: 'none',
  rotacion: 'none',
};

export function productPresets(): Array<{ id: string; label: string; view: Partial<GridView> }> {
  return withAggregates([
    { id: 'todos', label: 'Todos', view: { filters: [], sort: [{ key: 'producto', dir: 'asc' }] } },
    {
      id: 'alertas',
      label: 'Con alerta',
      view: {
        filters: [
          {
            key: 'alerta',
            op: 'in',
            value: ['Agotado', 'Bajo el mínimo', 'Se agota antes de reponer'],
          },
        ],
        sort: [{ key: 'existencia', dir: 'asc' }],
      },
    },
    {
      id: 'valor',
      label: 'Más plata quieta',
      view: { filters: [], sort: [{ key: 'valor', dir: 'desc' }] },
    },
    {
      id: 'quietos',
      label: 'Sin movimiento',
      view: {
        filters: [{ key: 'alerta', op: 'eq', value: 'Sin movimiento' }],
        sort: [{ key: 'valor', dir: 'desc' }],
      },
    },
  ]);
}

function withAggregates<T extends { view: Partial<GridView> }>(presets: T[]): T[] {
  return presets.map((p) => ({ ...p, view: { ...p.view, aggregates: AGGREGATES } }));
}

export function inventoryTiles(
  o: InventoryOverview,
  orders: PurchaseOrder[],
  suggestions: number,
): InventoryTile[] {
  const tracked = o.products.filter((p) => p.trackStock);
  const inbound = orders.filter((p) =>
    ['aprobada', 'enviada', 'recibida_parcial'].includes(p.status),
  );
  const pending = orders.filter((p) => p.status === 'por_aprobar');
  const stale = o.products.filter((p) => p.alert === 'sin_movimiento');
  const staleValue = stale.reduce((s, p) => s + (p.value ?? 0), 0);
  return [
    {
      label: 'Valor del inventario',
      value: money(o.totals.value),
      note: `${tracked.length} ${tracked.length === 1 ? 'producto' : 'productos'} con existencias, al costo promedio`,
      tone: 'neutral',
    },
    {
      label: 'Bajo el mínimo',
      value: String(o.totals.belowMin + o.totals.outOfStock),
      note: o.totals.outOfStock
        ? `${o.totals.outOfStock} ${o.totals.outOfStock === 1 ? 'agotado' : 'agotados'}`
        : 'Ninguno agotado',
      tone: o.totals.outOfStock ? 'rose' : o.totals.belowMin ? 'amber' : 'emerald',
    },
    {
      label: 'Por reponer',
      value: String(suggestions),
      note: suggestions ? 'Ya descontado lo que viene pedido' : 'Nada por pedir hoy',
      tone: suggestions ? 'amber' : 'emerald',
    },
    {
      label: 'Compras en camino',
      value: money(inbound.reduce((s, p) => s + p.total, 0)),
      note: `${inbound.length} ${inbound.length === 1 ? 'orden' : 'órdenes'}${pending.length ? ` · ${pending.length} por aprobar` : ''}`,
      tone: pending.length ? 'amber' : 'primary',
    },
    {
      label: 'Plata quieta',
      value: money(staleValue),
      note: stale.length
        ? `${stale.length} ${stale.length === 1 ? 'producto' : 'productos'} sin movimiento en 90 días`
        : 'Todo se mueve',
      tone: stale.length ? 'amber' : 'neutral',
    },
  ];
}

// ---------------------------------------------------------------------------
// Reposición
// ---------------------------------------------------------------------------

export function reorderGroups(plan: ReorderPlan, units: Map<string, string>): ReorderGroupView[] {
  return plan.groups.map((g) => ({
    key: g.supplierId ?? 'sin-proveedor',
    supplierId: g.supplierId,
    supplierName: g.supplierName,
    totalLabel: money(g.total, plan.currency),
    missingCost: g.missingCost,
    leadLabel: g.leadTimeDays !== null ? `${g.leadTimeDays} días de entrega` : null,
    lines: g.lines.map((l) => ({
      productId: l.productId,
      name: l.name,
      sku: l.sku,
      qty: l.qty,
      unit: units.get(l.productId) ?? l.unit,
      qtyLabel: qty(l.qty, l.unit),
      why: l.why,
      onHandLabel: qty(l.onHand, l.unit),
      minLabel: l.minStock !== null ? qty(l.minStock, l.unit) : null,
      costLabel: l.unitCost !== null ? money(l.unitCost, plan.currency) : null,
      totalLabel: l.lineTotal !== null ? money(l.lineTotal, plan.currency) : null,
      urgent: l.onHand <= 0,
    })),
  }));
}

// ---------------------------------------------------------------------------
// Órdenes
// ---------------------------------------------------------------------------

export function poListItem(po: PurchaseOrder): PoListItem {
  const ordered = po.lines.reduce((s, l) => s + l.qty, 0);
  const received = po.lines.reduce((s, l) => s + l.qtyReceived, 0);
  return {
    id: po.id,
    label: po.label,
    supplierName: po.supplierName,
    statusLabel: PO_STATUS_LABEL[po.status],
    tone: PO_STATUS_TONE[po.status],
    totalLabel: money(po.total, po.currency),
    linesLabel: `${po.lines.length} ${po.lines.length === 1 ? 'producto' : 'productos'}`,
    createdLabel: shortDay(po.createdAt),
    expectedLabel: po.expectedOn ? shortDay(po.expectedOn) : null,
    progress: ordered > 0 ? Math.min(1, received / ordered) : 0,
    href: `/inventario/ordenes/${po.id}`,
  };
}

const STEP_OF: Record<string, number> = {
  borrador: 0,
  por_aprobar: 1,
  aprobada: 2,
  enviada: 3,
  recibida_parcial: 3,
  recibida: 4,
  facturada: 5,
  cerrada: 5,
  cancelada: -1,
};

export function poDetail(
  po: PurchaseOrder,
  ctx: {
    locations: StockLocationRow[];
    canApprove: boolean;
    names: Map<string, string>;
  },
): PoDetailView {
  const s = po.status;
  const location = ctx.locations.find((l) => l.id === po.locationId);
  const who = (id: string | null) => (id ? (ctx.names.get(id) ?? 'alguien del equipo') : null);
  const history: PoDetailView['history'] = [
    {
      label: `Creada${who(po.requestedBy) ? ` por ${who(po.requestedBy)}` : ''}`,
      when: shortDay(po.createdAt),
    },
  ];
  if (po.approvedAt)
    history.push({
      label: `Aprobada por ${who(po.approvedBy) ?? 'alguien del equipo'}`,
      when: shortDay(po.approvedAt),
    });
  if (po.sentAt)
    history.push({ label: `Enviada a ${po.sentTo ?? 'el proveedor'}`, when: shortDay(po.sentAt) });
  if (po.receivedAt)
    history.push({
      label: s === 'recibida_parcial' ? 'Recibida en parte' : 'Recibida',
      when: shortDay(po.receivedAt),
    });
  if (po.invoicedAt)
    history.push({ label: 'Facturada por el proveedor', when: shortDay(po.invoicedAt) });
  if (s === 'cancelada')
    history.push({
      label: `Cancelada${po.cancelledReason ? `: ${po.cancelledReason}` : ''}`,
      when: '',
    });
  return {
    id: po.id,
    label: po.label,
    status: s,
    statusLabel: PO_STATUS_LABEL[s],
    tone: PO_STATUS_TONE[s],
    step: STEP_OF[s] ?? 0,
    supplierName: po.supplierName,
    supplierTaxId: po.supplierTaxId,
    supplierEmail: po.supplierEmail,
    totals: {
      subtotal: money(po.subtotal, po.currency),
      tax: po.taxTotal > 0 ? money(po.taxTotal, po.currency) : null,
      total: money(po.total, po.currency),
    },
    facts: [
      { label: 'Entregar en', value: location?.name ?? 'Bodega principal' },
      { label: 'Llega', value: po.expectedOn ? shortDay(po.expectedOn) : 'Sin fecha' },
      { label: 'Plazo de pago', value: po.termsDays ? `${po.termsDays} días` : 'De contado' },
      {
        label: 'En el libro de plata',
        value: ['aprobada', 'enviada', 'recibida_parcial', 'recibida'].includes(s)
          ? 'Por pagar esperado'
          : s === 'facturada' || s === 'cerrada'
            ? 'Reemplazada por la factura'
            : 'Todavía no',
      },
    ],
    lines: po.lines.map((l) => ({
      id: l.id,
      description: l.description,
      unit: l.unit,
      qty: l.qty,
      qtyLabel: qty(l.qty, l.unit),
      receivedLabel: qty(l.qtyReceived),
      pending: l.pending,
      costLabel: money(l.unitCost, po.currency),
      totalLabel: money(l.lineTotal, po.currency),
      productHref: l.productId ? `/inventario/${l.productId}` : null,
      done: l.pending <= 0,
    })),
    notes: po.notes,
    pdfHref: `/api/inventario/ordenes/${po.id}/pdf`,
    can: {
      edit: s === 'borrador' || s === 'por_aprobar',
      submit: s === 'borrador',
      approve: (s === 'borrador' || s === 'por_aprobar') && ctx.canApprove,
      send:
        ['aprobada', 'enviada', 'recibida_parcial', 'recibida'].includes(s) ||
        ((s === 'por_aprobar' || s === 'borrador') && ctx.canApprove),
      receive:
        ['aprobada', 'enviada', 'recibida_parcial', 'facturada'].includes(s) &&
        po.lines.some((l) => l.pending > 0),
      cancel: ['borrador', 'por_aprobar', 'aprobada', 'enviada'].includes(s),
    },
    locations: ctx.locations.map((l) => ({ id: l.id, name: l.name })),
    defaultLocationId: po.locationId,
    history,
  };
}

// ---------------------------------------------------------------------------
// Bodegas y conteo
// ---------------------------------------------------------------------------

export function locationViews(o: InventoryOverview): LocationView[] {
  return o.locations.map((l) => {
    let products = 0;
    let units = 0;
    let value = 0;
    for (const p of o.products) {
      const q = p.byLocation[l.id] ?? 0;
      if (q === 0) continue;
      products += 1;
      units += q;
      value += Math.max(q, 0) * (p.cost ?? 0);
    }
    return {
      id: l.id,
      name: l.name,
      isDefault: l.is_default,
      products,
      units: qty(units),
      valueLabel: money(value),
      sourceLabel: l.source_system ? (SOURCE_LABEL[l.source_system] ?? l.source_system) : null,
    };
  });
}

export function countRows(o: InventoryOverview): CountRowView[] {
  return o.products
    .filter((p) => p.trackStock && p.active)
    .map((p) => ({
      productId: p.id,
      name: p.name,
      sku: p.sku,
      unit: p.unit,
      system: p.byLocation,
      costLabel: p.cost !== null ? money(p.cost) : null,
    }));
}

// ---------------------------------------------------------------------------
// Ficha de un producto
// ---------------------------------------------------------------------------

const KIND_TONE: Record<string, Tone> = {
  entrada: 'emerald',
  salida: 'rose',
  ajuste: 'amber',
  traslado: 'primary',
};

export function productDetail(
  p: ProductOverview,
  ctx: {
    movements: StockMovementRow[];
    consumption: StockConsumption;
    locations: StockLocationRow[];
  },
): ProductDetailView {
  const names = new Map(ctx.locations.map((l) => [l.id, l.name]));
  const total = Math.max(p.onHand ?? 0, 0);
  const weekly = ctx.consumption.weekly.map((w) => ({ label: shortDay(w.weekStart), qty: w.qty }));
  return {
    id: p.id,
    name: p.name,
    sku: p.sku,
    unit: p.unit,
    category: p.category,
    alertLabel: STOCK_ALERT_LABEL[p.alert],
    alertTone: STOCK_ALERT_TONE[p.alert],
    sourceLabel: sourceLabel(p),
    supplierName: p.supplierName,
    tiles: [
      {
        label: 'Existencia',
        value: qty(p.onHand, p.unit),
        note: p.minStock !== null ? `Mínimo ${qty(p.minStock, p.unit)}` : 'Sin mínimo fijado',
        tone: STOCK_ALERT_TONE[p.alert] === 'emerald' ? 'neutral' : STOCK_ALERT_TONE[p.alert],
      },
      {
        label: 'Costo promedio',
        value: money(p.cost),
        note: 'Ponderado por cada entrada',
        tone: 'neutral',
      },
      {
        label: 'Valor',
        value: money(p.value),
        note: 'Existencia × costo promedio',
        tone: 'neutral',
      },
      {
        label: 'Días que alcanza',
        value: p.daysOfCover !== null ? `${p.daysOfCover} días` : '—',
        note: p.leadTimeDays !== null ? `Entrega en ${p.leadTimeDays} días` : 'Sin días de entrega',
        tone: p.alert === 'se_agota' ? 'amber' : 'neutral',
      },
      {
        label: 'Rotación',
        value: p.turnover !== null ? `${p.turnover.toLocaleString('es-CO')} veces/año` : '—',
        note: `${qty(p.outQty, p.unit)} en 90 días`,
        tone: 'neutral',
      },
    ],
    weekly,
    weeklyMax: Math.max(1, ...weekly.map((w) => w.qty)),
    dailyLabel: `${qty(Math.round(p.dailyUse * 100) / 100, p.unit)} por día`,
    byLocation: Object.entries(p.byLocation)
      .filter(([, q]) => q !== 0)
      .map(([id, q]) => ({
        name: names.get(id) ?? 'Bodega',
        qtyLabel: qty(q, p.unit),
        share: total > 0 ? Math.max(q, 0) / total : 0,
      })),
    movements: ctx.movements.map((m) => {
      const q = Number(m.qty);
      return {
        id: m.id,
        dateLabel: shortDay(m.occurred_on),
        kindLabel: MOVEMENT_KIND_LABEL[m.kind],
        tone: KIND_TONE[m.kind] ?? 'neutral',
        qtyLabel: `${q > 0 ? '+' : ''}${qty(q)}`,
        locationName: names.get(m.location_id) ?? 'Bodega',
        referenceLabel: m.reference_label ?? REFERENCE_KIND_LABEL[m.reference_kind],
        href: m.purchase_order_id ? `/inventario/ordenes/${m.purchase_order_id}` : null,
        costLabel: m.unit_cost !== null ? money(Number(m.unit_cost)) : null,
        note: m.note,
      };
    }),
    locations: ctx.locations.map((l) => ({ id: l.id, name: l.name })),
    settings: {
      minStock: p.minStock,
      reorderQty: p.reorderQty,
      leadTimeDays: p.leadTimeDays,
      price: p.price,
    },
    stockFromAccounting: p.stockFrom === 'accounting',
  };
}
