import {
  type InventoryOverview,
  PO_STATUS_LABEL,
  type ProductOverview,
  type PurchaseOrder,
  type ReorderPlan,
  type StockLocationRow,
  type StockMovementRow,
  type SupplierRef,
  annualTurnover,
  groupBySupplier,
  productAlert,
  reorderSuggestions,
  stockConsumption,
} from '@cortex/agent-tools';

/**
 * INVENTARIO INVENTADO: Ferretería y Construcciones del Valle. Sólo para el
 * escaparate de desarrollo. Las cifras salen del motor de verdad (alertas,
 * rotación, sugerencias de reposición): lo único inventado es el libro.
 */

export const TODAY = '2026-10-03';

export const SUPPLIERS: SupplierRef[] = [
  {
    id: 's1',
    name: 'Ferretería Central S.A.S.',
    nit: '900123456',
    email: 'ventas@ferrecentral.co',
    termsDays: 30,
    approverId: null,
  },
  {
    id: 's2',
    name: 'Cementos del Pacífico',
    nit: '890300456',
    email: 'pedidos@cempacifico.co',
    termsDays: 45,
    approverId: null,
  },
  {
    id: 's3',
    name: 'Pinturas Andinas',
    nit: '901777888',
    email: null,
    termsDays: 30,
    approverId: null,
  },
];

export const LOCATIONS: StockLocationRow[] = [
  {
    id: 'b1',
    name: 'Bodega principal',
    code: null,
    address: 'Cra 5 # 12-30, Cali',
    is_default: true,
    active: true,
    source_system: null,
    source_ref: null,
  },
  {
    id: 'b2',
    name: 'Obra Jamundí',
    code: null,
    address: null,
    is_default: false,
    active: true,
    source_system: null,
    source_ref: null,
  },
  {
    id: 'b3',
    name: 'Principal (Siigo)',
    code: null,
    address: null,
    is_default: false,
    active: true,
    source_system: 'siigo',
    source_ref: '1',
  },
];

interface Seed {
  id: string;
  sku: string;
  name: string;
  unit: string;
  category: string;
  onHand: Record<string, number>;
  min: number | null;
  reorder: number | null;
  lead: number | null;
  cost: number | null;
  price: number | null;
  daily: number;
  supplier: string | null;
  last: string | null;
  source?: 'manual' | 'sheet' | 'accounting';
}

const SEEDS: Seed[] = [
  {
    id: 'p1',
    sku: 'TOR-10',
    name: 'Tornillo drywall 10mm (caja x100)',
    unit: 'caja',
    category: 'Tornillería',
    onHand: { b1: 12, b2: 4 },
    min: 40,
    reorder: 120,
    lead: 5,
    cost: 18_500,
    price: 26_000,
    daily: 3.2,
    supplier: 's1',
    last: '2026-10-02',
    source: 'sheet',
  },
  {
    id: 'p2',
    sku: 'CEM-50',
    name: 'Cemento gris 50 kg',
    unit: 'bulto',
    category: 'Obra gris',
    onHand: { b3: 35 },
    min: 60,
    reorder: null,
    lead: 7,
    cost: 31_200,
    price: 38_500,
    daily: 6.5,
    supplier: 's2',
    last: '2026-10-03',
    source: 'accounting',
  },
  {
    id: 'p3',
    sku: 'VAR-12',
    name: 'Varilla corrugada 1/2"',
    unit: 'und',
    category: 'Obra gris',
    onHand: { b1: 0 },
    min: 80,
    reorder: 200,
    lead: 7,
    cost: 24_900,
    price: 31_000,
    daily: 4.1,
    supplier: 's2',
    last: '2026-09-28',
  },
  {
    id: 'p4',
    sku: 'PIN-BL',
    name: 'Pintura vinilo blanco tipo 1 (galón)',
    unit: 'galón',
    category: 'Pinturas',
    onHand: { b1: 22 },
    min: null,
    reorder: null,
    lead: 10,
    cost: 52_000,
    price: 74_900,
    daily: 2.6,
    supplier: 's3',
    last: '2026-10-01',
  },
  {
    id: 'p5',
    sku: 'GUA-NIT',
    name: 'Guantes de nitrilo (par)',
    unit: 'par',
    category: 'Seguridad',
    onHand: { b1: 140, b2: 60 },
    min: 50,
    reorder: 300,
    lead: 4,
    cost: 2_400,
    price: 4_500,
    daily: 5,
    supplier: 's1',
    last: '2026-10-02',
  },
  {
    id: 'p6',
    sku: 'TUB-PVC',
    name: 'Tubo PVC sanitario 4" x 6 m',
    unit: 'und',
    category: 'Plomería',
    onHand: { b1: 18 },
    min: 10,
    reorder: 40,
    lead: 6,
    cost: 46_800,
    price: 61_000,
    daily: 0.6,
    supplier: null,
    last: '2026-09-30',
  },
  {
    id: 'p7',
    sku: 'ESC-AL',
    name: 'Escalera aluminio 6 pasos',
    unit: 'und',
    category: 'Herramienta',
    onHand: { b1: 9 },
    min: 2,
    reorder: null,
    lead: 15,
    cost: 189_000,
    price: 259_000,
    daily: 0,
    supplier: 's1',
    last: '2026-05-11',
  },
  {
    id: 'p8',
    sku: 'LIJ-120',
    name: 'Lija de agua grano 120',
    unit: 'pliego',
    category: 'Pinturas',
    onHand: { b1: 3 },
    min: 25,
    reorder: 100,
    lead: 3,
    cost: 1_150,
    price: 2_200,
    daily: 1.8,
    supplier: null,
    last: '2026-10-02',
  },
  {
    id: 'p9',
    sku: 'SRV-INS',
    name: 'Instalación de drywall (m²)',
    unit: 'm²',
    category: 'Servicios',
    onHand: {},
    min: null,
    reorder: null,
    lead: null,
    cost: null,
    price: 28_000,
    daily: 0,
    supplier: null,
    last: null,
  },
];

function overviewOf(s: Seed): ProductOverview {
  const total = Object.values(s.onHand).reduce((a, b) => a + b, 0);
  const track = s.sku !== 'SRV-INS';
  const consumption = { outQty: s.daily * 90, daily: s.daily, windowDays: 90, weekly: [] };
  const daysOfCover = s.daily > 0 ? Math.floor(total / s.daily) : null;
  return {
    id: s.id,
    sku: s.sku,
    name: s.name,
    unit: s.unit,
    category: s.category,
    currency: 'COP',
    price: s.price,
    cost: s.cost,
    onHand: track ? total : null,
    trackStock: track,
    active: true,
    minStock: s.min,
    reorderQty: s.reorder,
    leadTimeDays: s.lead,
    preferredSupplierId: s.supplier,
    source: s.source ?? 'manual',
    sourceSystem: s.source === 'accounting' ? 'siigo' : null,
    sourceRef: s.source === 'accounting' ? `sg-${s.id}` : null,
    stockFrom: s.source === 'accounting' ? 'accounting' : 'cortex',
    byLocation: s.onHand,
    value: track && s.cost !== null ? total * s.cost : null,
    dailyUse: s.daily,
    outQty: consumption.outQty,
    daysOfCover: track ? daysOfCover : null,
    turnover: track ? annualTurnover(total, consumption) : null,
    lastMovementOn: s.last,
    alert: productAlert({
      onHand: total,
      minStock: s.min,
      daily: s.daily,
      leadTimeDays: s.lead,
      lastMovementOn: s.last,
      today: TODAY,
      trackStock: track,
    }),
    supplierName: SUPPLIERS.find((x) => x.id === s.supplier)?.name ?? null,
  };
}

export function fixtureOverview(empty = false): InventoryOverview {
  const products = empty ? [] : SEEDS.map(overviewOf);
  return {
    products,
    locations: LOCATIONS,
    totals: {
      products: products.length,
      value: products.reduce((s, p) => s + (p.value ?? 0), 0),
      belowMin: products.filter((p) => p.alert === 'bajo_minimo').length,
      outOfStock: products.filter((p) => p.alert === 'agotado').length,
    },
  };
}

const line = (
  id: string,
  productId: string,
  description: string,
  unit: string,
  qty: number,
  unitCost: number,
  qtyReceived = 0,
  taxRate = 19,
) => ({
  id,
  productId,
  position: 0,
  description,
  unit,
  qty,
  unitCost,
  taxRate,
  qtyReceived,
  pending: qty - qtyReceived,
  lineTotal: qty * unitCost,
});

function po(
  over: Partial<PurchaseOrder> &
    Pick<PurchaseOrder, 'id' | 'number' | 'status' | 'supplierName' | 'lines'>,
): PurchaseOrder {
  const subtotal = over.lines.reduce((s, l) => s + l.lineTotal, 0);
  const tax = over.lines.reduce((s, l) => s + (l.lineTotal * l.taxRate) / 100, 0);
  return {
    label: `OC-${String(over.number).padStart(4, '0')}`,
    statusLabel: PO_STATUS_LABEL[over.status],
    supplierId: 's1',
    supplierTaxId: '900123456',
    supplierEmail: 'ventas@ferrecentral.co',
    currency: 'COP',
    subtotal,
    taxTotal: tax,
    total: subtotal + tax,
    expectedOn: '2026-10-08',
    locationId: 'b1',
    termsDays: 30,
    notes: null,
    origin: 'sugerencia',
    approvalId: null,
    requestedBy: 'u2',
    approvedBy: null,
    approvedAt: null,
    sentAt: null,
    sentTo: null,
    receivedAt: null,
    invoicedAt: null,
    payableId: null,
    cancelledReason: null,
    createdAt: '2026-09-29T14:00:00Z',
    ...over,
  };
}

export const ORDERS: PurchaseOrder[] = [
  po({
    id: 'po14',
    number: 14,
    status: 'por_aprobar',
    supplierName: 'Ferretería Central S.A.S.',
    createdAt: '2026-10-03T08:10:00Z',
    lines: [line('l1', 'p1', 'TOR-10 · Tornillo drywall 10mm (caja x100)', 'caja', 120, 18_500)],
  }),
  po({
    id: 'po13',
    number: 13,
    status: 'enviada',
    supplierName: 'Cementos del Pacífico',
    supplierId: 's2',
    supplierEmail: 'pedidos@cempacifico.co',
    termsDays: 45,
    approvedAt: '2026-09-30T15:00:00Z',
    approvedBy: 'u1',
    sentAt: '2026-09-30T15:01:00Z',
    sentTo: 'pedidos@cempacifico.co',
    expectedOn: '2026-10-07',
    notes: 'Entregar en horario de 7 a. m. a 4 p. m. Avisar al llegar a portería.',
    lines: [
      line('l2', 'p2', 'CEM-50 · Cemento gris 50 kg', 'bulto', 150, 31_200),
      { ...line('l3', 'p3', 'VAR-12 · Varilla corrugada 1/2"', 'und', 200, 24_900), position: 1 },
    ],
  }),
  po({
    id: 'po12',
    number: 12,
    status: 'recibida_parcial',
    supplierName: 'Ferretería Central S.A.S.',
    approvedAt: '2026-09-22T10:00:00Z',
    sentAt: '2026-09-22T10:02:00Z',
    receivedAt: '2026-09-27T09:00:00Z',
    lines: [line('l4', 'p5', 'GUA-NIT · Guantes de nitrilo (par)', 'par', 300, 2_400, 200)],
  }),
  po({
    id: 'po11',
    number: 11,
    status: 'facturada',
    supplierName: 'Pinturas Andinas',
    supplierEmail: null,
    approvedAt: '2026-09-10T10:00:00Z',
    sentAt: '2026-09-10T10:02:00Z',
    receivedAt: '2026-09-15T09:00:00Z',
    invoicedAt: '2026-09-16T09:00:00Z',
    payableId: 'pay-1',
    createdAt: '2026-09-09T10:00:00Z',
    lines: [
      line('l5', 'p4', 'PIN-BL · Pintura vinilo blanco tipo 1 (galón)', 'galón', 40, 52_000, 40),
    ],
  }),
  po({
    id: 'po10',
    number: 10,
    status: 'cancelada',
    supplierName: 'Ferretería Central S.A.S.',
    cancelledReason: 'El proveedor no tenía existencias',
    createdAt: '2026-09-02T10:00:00Z',
    lines: [line('l6', 'p7', 'ESC-AL · Escalera aluminio 6 pasos', 'und', 4, 189_000)],
  }),
];

export function fixturePlan(overview: InventoryOverview): ReorderPlan {
  const onOrder = new Map<string, number>();
  for (const o of ORDERS)
    if (['aprobada', 'enviada', 'recibida_parcial', 'por_aprobar'].includes(o.status))
      for (const l of o.lines)
        if (l.productId) onOrder.set(l.productId, (onOrder.get(l.productId) ?? 0) + l.pending);
  // Para el escaparate, la orden por aprobar de tornillos no cuenta: así se ve
  // el grupo de Ferretería con sus líneas.
  onOrder.delete('p1');
  const suggestions = reorderSuggestions(
    overview.products.map((p) => ({
      productId: p.id,
      name: p.name,
      sku: p.sku,
      unit: p.unit,
      onHand: p.onHand ?? 0,
      onOrder: p.id === 'p2' ? 0 : (onOrder.get(p.id) ?? 0),
      minStock: p.minStock,
      reorderQty: p.reorderQty,
      leadTimeDays: p.leadTimeDays,
      daily: p.dailyUse,
      unitCost: p.cost,
      supplierId: p.preferredSupplierId,
      supplierName: p.supplierName,
      trackStock: p.trackStock,
      active: p.active,
    })),
  );
  return { suggestions, groups: groupBySupplier(suggestions), currency: 'COP' };
}

export function fixtureMovements(productId: string): {
  movements: StockMovementRow[];
  consumption: ReturnType<typeof stockConsumption>;
} {
  const out: StockMovementRow[] = [];
  const ledger: Array<{ kind: 'salida'; qty: number; occurredOn: string }> = [];
  let n = 0;
  for (let d = 0; d < 90; d += 1) {
    const day = new Date(Date.parse(`${TODAY}T00:00:00Z`) - d * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
    if (weekday === 0) continue;
    const q = Math.max(0, Math.round(3 + Math.sin(d / 5) * 2 + (d < 14 ? 1.5 : 0)));
    if (q === 0) continue;
    ledger.push({ kind: 'salida', qty: -q, occurredOn: day });
    n += 1;
    if (d < 12)
      out.push({
        id: `m${n}`,
        product_id: productId,
        location_id: d % 4 === 0 ? 'b2' : 'b1',
        kind: 'salida',
        qty: -q,
        unit_cost: 18_500,
        reference_kind: 'factura',
        reference_id: null,
        reference_label: `Factura FE-${2210 - d}`,
        purchase_order_id: null,
        transfer_id: null,
        note: null,
        occurred_on: day,
        created_by: null,
        created_at: `${day}T15:00:00Z`,
      });
  }
  out.splice(3, 0, {
    id: 'm-in',
    product_id: productId,
    location_id: 'b1',
    kind: 'entrada',
    qty: 120,
    unit_cost: 18_200,
    reference_kind: 'orden_compra',
    reference_id: 'po9',
    reference_label: 'OC-0009 · Ferretería Central S.A.S.',
    purchase_order_id: 'po9',
    transfer_id: null,
    note: null,
    occurred_on: '2026-09-30',
    created_by: null,
    created_at: '2026-09-30T10:00:00Z',
  });
  out.splice(6, 0, {
    id: 'm-adj',
    product_id: productId,
    location_id: 'b1',
    kind: 'ajuste',
    qty: -4,
    unit_cost: 18_400,
    reference_kind: 'conteo',
    reference_id: null,
    reference_label: 'Conteo: había 46, se contaron 42',
    purchase_order_id: null,
    transfer_id: null,
    note: 'Conteo de fin de mes',
    occurred_on: '2026-09-27',
    created_by: null,
    created_at: '2026-09-27T18:00:00Z',
  });
  out.sort((a, b) => b.occurred_on.localeCompare(a.occurred_on));
  return { movements: out, consumption: stockConsumption(ledger, TODAY) };
}
