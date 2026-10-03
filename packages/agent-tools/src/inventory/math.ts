import {
  type MovementKind,
  type PoStatus,
  type ReferenceKind,
  type StockAlert,
  formatQty,
  round,
} from './shape';

/**
 * EL MOTOR DEL INVENTARIO, SIN BASE NI RELOJ (migración 0183).
 *
 * Todo lo que es aritmética vive aquí y se prueba aquí (math.test.ts):
 *
 *   - existencias: la suma del libro, por producto y por bodega;
 *   - costo promedio ponderado: cada entrada con costo mueve el promedio, las
 *     salidas no lo tocan (salen al promedio vigente);
 *   - consumo: las salidas de los últimos N días, por día y por semana;
 *   - la alerta de cada producto y su rotación;
 *   - sugerencias de reposición: bajo el mínimo → pedir `reorder_qty`, o lo
 *     que cubra el hueco hasta el mínimo más el consumo durante los días de
 *     entrega; lo ya pedido (órdenes en camino) cuenta como si hubiera llegado;
 *   - totales de una orden y el plan de una recepción parcial o total.
 *
 * Fechas: `YYYY-MM-DD`. Cantidades: números (los almacenes convierten el texto
 * de `numeric`).
 */

// ---------------------------------------------------------------------------
// Fechas mínimas (sin depender de otros módulos para que el motor sea puro)
// ---------------------------------------------------------------------------

function dayNumber(day: string): number {
  return Math.floor(Date.parse(`${day.slice(0, 10)}T00:00:00Z`) / 86_400_000);
}

export function addDaysIso(day: string, days: number): string {
  return new Date((dayNumber(day) + days) * 86_400_000).toISOString().slice(0, 10);
}

export function daysFrom(from: string, to: string): number {
  return dayNumber(to) - dayNumber(from);
}

// ---------------------------------------------------------------------------
// Existencias
// ---------------------------------------------------------------------------

export interface LevelInput {
  productId: string;
  locationId: string;
  onHand: number;
}

export interface ProductStock {
  total: number;
  byLocation: Map<string, number>;
}

/** Las filas de `stock_levels` (o movimientos sueltos) → existencias por producto. */
export function stockByProduct(levels: readonly LevelInput[]): Map<string, ProductStock> {
  const out = new Map<string, ProductStock>();
  for (const l of levels) {
    const entry = out.get(l.productId) ?? { total: 0, byLocation: new Map<string, number>() };
    entry.total = round(entry.total + l.onHand, 4);
    entry.byLocation.set(
      l.locationId,
      round((entry.byLocation.get(l.locationId) ?? 0) + l.onHand, 4),
    );
    out.set(l.productId, entry);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Costo promedio ponderado
// ---------------------------------------------------------------------------

export interface CostState {
  onHand: number;
  /** Costo promedio por unidad, o null si nunca entró nada con costo. */
  cost: number | null;
}

export interface CostMovement {
  kind: MovementKind;
  qty: number;
  unitCost?: number | null;
}

/**
 * El estado después de un movimiento.
 *
 * Una ENTRADA con costo (o un ajuste positivo con costo) promedia:
 *   (existencia × costo + cantidad × costo nuevo) / (existencia + cantidad).
 * Si la existencia era cero o negativa (se vendió lo que no estaba
 * registrado), el promedio viejo no pesa: manda el costo nuevo.
 * Una entrada sin costo, una salida, un traslado o un ajuste negativo cambian
 * la existencia pero no el costo.
 */
export function averageCostAfter(state: CostState, m: CostMovement): CostState {
  const onHand = round(state.onHand + m.qty, 4);
  const incoming = m.qty > 0 && m.kind !== 'traslado';
  const unitCost = m.unitCost ?? null;
  if (!incoming || unitCost === null || unitCost < 0) return { onHand, cost: state.cost };
  const base = state.onHand > 0 && state.cost !== null ? state.onHand : 0;
  const cost = base > 0 ? (base * (state.cost ?? 0) + m.qty * unitCost) / (base + m.qty) : unitCost;
  return { onHand, cost: round(cost, 4) };
}

/** Recalcular desde el libro entero, en orden. */
export function replayAverageCost(
  movements: readonly CostMovement[],
  start: CostState = { onHand: 0, cost: null },
): CostState {
  return movements.reduce(averageCostAfter, start);
}

// ---------------------------------------------------------------------------
// Consumo
// ---------------------------------------------------------------------------

export interface ConsumptionMovement {
  kind: MovementKind;
  qty: number;
  occurredOn: string;
  referenceKind?: ReferenceKind;
}

export interface Consumption {
  /** Unidades que salieron en la ventana (positivo). */
  outQty: number;
  /** Promedio diario en la ventana. */
  daily: number;
  windowDays: number;
  /** Salidas por semana (la más vieja primero), para la gráfica. */
  weekly: Array<{ weekStart: string; qty: number }>;
}

export const CONSUMPTION_WINDOW_DAYS = 90;

/**
 * Cuánto se consume. Cuentan las SALIDAS (ventas, facturas, consumo a mano);
 * los ajustes de conteo o de sincronización no son consumo: son corregir el
 * número, y contarlos haría creer que se vende lo que se perdió o se contó mal.
 */
export function consumption(
  movements: readonly ConsumptionMovement[],
  today: string,
  windowDays = CONSUMPTION_WINDOW_DAYS,
): Consumption {
  const from = addDaysIso(today, -windowDays + 1);
  const weeks = Math.ceil(windowDays / 7);
  const firstWeek = addDaysIso(today, -(weeks * 7) + 1);
  const weekly = Array.from({ length: weeks }, (_, i) => ({
    weekStart: addDaysIso(firstWeek, i * 7),
    qty: 0,
  }));
  let outQty = 0;
  for (const m of movements) {
    if (m.kind !== 'salida' || m.qty >= 0) continue;
    if (m.occurredOn > today) continue;
    const out = -m.qty;
    if (m.occurredOn >= from) outQty += out;
    const w = Math.floor(daysFrom(firstWeek, m.occurredOn) / 7);
    const bucket = weekly[w];
    if (w >= 0 && bucket) bucket.qty = round(bucket.qty + out, 4);
  }
  return {
    outQty: round(outQty, 4),
    daily: round(outQty / Math.max(windowDays, 1), 4),
    windowDays,
    weekly,
  };
}

/** Días que alcanza lo que hay al ritmo de consumo; null si no se consume. */
export function daysOfCover(onHand: number, daily: number): number | null {
  if (daily <= 0) return null;
  return Math.max(0, Math.floor(onHand / daily));
}

/**
 * Rotación anual: cuántas veces al año se vende el inventario que hay hoy
 * (consumo anualizado ÷ existencia). null si no hay existencia o consumo.
 */
export function annualTurnover(onHand: number, c: Consumption): number | null {
  if (onHand <= 0 || c.outQty <= 0) return null;
  return round((c.outQty * (365 / c.windowDays)) / onHand, 1);
}

// ---------------------------------------------------------------------------
// La alerta de un producto
// ---------------------------------------------------------------------------

export const STALE_DAYS = 90;

export function productAlert(input: {
  onHand: number;
  minStock: number | null;
  daily: number;
  leadTimeDays: number | null;
  lastMovementOn: string | null;
  today: string;
  trackStock?: boolean;
}): StockAlert {
  if (input.trackStock === false) return 'ok';
  if (input.onHand <= 0 && (input.minStock ?? 0) > 0) return 'agotado';
  if (input.onHand <= 0 && input.daily > 0) return 'agotado';
  if (input.minStock !== null && input.minStock > 0 && input.onHand <= input.minStock)
    return 'bajo_minimo';
  const cover = daysOfCover(input.onHand, input.daily);
  const lead = input.leadTimeDays ?? 0;
  if (cover !== null && lead > 0 && cover <= lead) return 'se_agota';
  if (
    input.onHand > 0 &&
    (!input.lastMovementOn || daysFrom(input.lastMovementOn, input.today) > STALE_DAYS)
  )
    return 'sin_movimiento';
  return 'ok';
}

// ---------------------------------------------------------------------------
// Reposición
// ---------------------------------------------------------------------------

export interface ReorderInput {
  productId: string;
  name: string;
  sku: string | null;
  unit: string;
  onHand: number;
  /** Unidades pedidas en órdenes aprobadas/enviadas que no han llegado. */
  onOrder: number;
  minStock: number | null;
  reorderQty: number | null;
  leadTimeDays: number | null;
  daily: number;
  /** Último costo de compra, o el promedio; null si no se sabe. */
  unitCost: number | null;
  supplierId: string | null;
  supplierName: string | null;
  trackStock?: boolean;
  active?: boolean;
}

export type ReorderReason = 'bajo_minimo' | 'se_agota';

export interface ReorderSuggestion {
  productId: string;
  name: string;
  sku: string | null;
  unit: string;
  onHand: number;
  onOrder: number;
  minStock: number | null;
  qty: number;
  reason: ReorderReason;
  /** La cuenta en español, para la tarjeta y para el modelo. */
  why: string;
  unitCost: number | null;
  lineTotal: number | null;
  supplierId: string | null;
  supplierName: string | null;
  /** Días de entrega con que se calculó. */
  leadTimeDays: number;
}

/** Días de entrega cuando el producto no los dice. */
export const DEFAULT_LEAD_TIME_DAYS = 7;

/**
 * ¿Hay que pedir este producto, y cuánto?
 *
 *   disponible = existencia + lo que ya viene en camino
 *   dispara    disponible ≤ mínimo                         (bajo_minimo)
 *              o, sin mínimo, disponible no cubre el consumo
 *              de los días de entrega                       (se_agota)
 *   cantidad   `reorder_qty` si está (y al menos el hueco hasta el mínimo);
 *              si no, el hueco hasta el mínimo + el consumo de los días de
 *              entrega, redondeado hacia arriba (mínimo 1).
 *
 * Lo que ya viene pedido y alcanza no se vuelve a sugerir: es la manera de no
 * pedir dos veces lo mismo cuando el piloto mira cada mañana.
 */
export function reorderFor(p: ReorderInput): ReorderSuggestion | null {
  if (p.trackStock === false || p.active === false) return null;
  const available = round(p.onHand + Math.max(p.onOrder, 0), 4);
  const lead = p.leadTimeDays ?? DEFAULT_LEAD_TIME_DAYS;
  const leadCover = p.daily * lead;
  const min = p.minStock !== null && p.minStock > 0 ? p.minStock : null;

  let reason: ReorderReason | null = null;
  if (min !== null && available <= min) reason = 'bajo_minimo';
  else if (min === null && p.daily > 0 && available <= leadCover) reason = 'se_agota';
  if (!reason) return null;

  const gap = Math.max((min ?? 0) - available, 0);
  const coverage = Math.ceil(round(gap + leadCover, 4));
  const qty =
    p.reorderQty !== null && p.reorderQty > 0
      ? Math.max(p.reorderQty, Math.ceil(gap))
      : Math.max(coverage, 1);

  const parts: string[] = [];
  parts.push(`Hay ${formatQty(p.onHand)} ${p.unit}`);
  if (p.onOrder > 0) parts.push(`y vienen ${formatQty(p.onOrder)} pedidos`);
  const head =
    reason === 'bajo_minimo'
      ? `${parts.join(' ')}; el mínimo es ${formatQty(min ?? 0)}.`
      : `${parts.join(' ')}; al ritmo de ${formatQty(round(p.daily, 2))} ${p.unit} por día no alcanzan los ${lead} días de entrega.`;
  const how =
    p.reorderQty !== null && p.reorderQty > 0
      ? qty === p.reorderQty
        ? `Pido la cantidad de reposición: ${formatQty(qty)}.`
        : `Pido ${formatQty(qty)} para volver al mínimo (la cantidad de reposición, ${formatQty(p.reorderQty)}, no alcanza).`
      : p.daily > 0
        ? `Pido ${formatQty(qty)}: ${gap > 0 ? `${formatQty(round(gap, 2))} para volver al mínimo y ` : ''}${formatQty(round(leadCover, 2))} para los ${lead} días de entrega.`
        : `Pido ${formatQty(qty)} para volver al mínimo.`;

  return {
    productId: p.productId,
    name: p.name,
    sku: p.sku,
    unit: p.unit,
    onHand: p.onHand,
    onOrder: p.onOrder,
    minStock: min,
    qty,
    reason,
    why: `${head} ${how}`,
    unitCost: p.unitCost,
    lineTotal: p.unitCost !== null ? round(qty * p.unitCost, 2) : null,
    supplierId: p.supplierId,
    supplierName: p.supplierName,
    leadTimeDays: lead,
  };
}

export function reorderSuggestions(products: readonly ReorderInput[]): ReorderSuggestion[] {
  return products
    .map(reorderFor)
    .filter((s): s is ReorderSuggestion => s !== null)
    .sort(
      (a, b) =>
        Number(a.reason !== 'bajo_minimo') - Number(b.reason !== 'bajo_minimo') ||
        a.onHand - b.onHand ||
        a.name.localeCompare(b.name, 'es'),
    );
}

export interface SupplierGroup {
  /** `null` = sin proveedor habitual: hay que elegirlo antes de pedir. */
  supplierId: string | null;
  supplierName: string | null;
  lines: ReorderSuggestion[];
  /** Suma de lo que tiene costo conocido. */
  total: number;
  /** Líneas sin costo conocido. */
  missingCost: number;
  /** El mayor de los días de entrega de sus líneas: cuándo debería llegar. */
  leadTimeDays: number | null;
}

/** Las sugerencias agrupadas por proveedor: una orden por grupo. */
export function groupBySupplier(suggestions: readonly ReorderSuggestion[]): SupplierGroup[] {
  const groups = new Map<string, SupplierGroup>();
  for (const s of suggestions) {
    const key = s.supplierId ?? '';
    const g = groups.get(key) ?? {
      supplierId: s.supplierId,
      supplierName: s.supplierName,
      lines: [],
      total: 0,
      missingCost: 0,
      leadTimeDays: null,
    };
    g.lines.push(s);
    g.leadTimeDays = Math.max(g.leadTimeDays ?? 0, s.leadTimeDays);
    if (s.lineTotal !== null) g.total = round(g.total + s.lineTotal, 2);
    else g.missingCost += 1;
    groups.set(key, g);
  }
  return [...groups.values()].sort(
    (a, b) =>
      Number(a.supplierId === null) - Number(b.supplierId === null) ||
      b.total - a.total ||
      (a.supplierName ?? '').localeCompare(b.supplierName ?? '', 'es'),
  );
}

// ---------------------------------------------------------------------------
// Órdenes de compra
// ---------------------------------------------------------------------------

export interface PoLineInput {
  qty: number;
  unitCost: number;
  /** IVA en porcentaje (19 = 19 %). */
  taxRate?: number;
}

export function poTotals(lines: readonly PoLineInput[]): {
  subtotal: number;
  taxTotal: number;
  total: number;
} {
  let subtotal = 0;
  let taxTotal = 0;
  for (const l of lines) {
    const base = l.qty * l.unitCost;
    subtotal += base;
    taxTotal += base * ((l.taxRate ?? 0) / 100);
  }
  return {
    subtotal: round(subtotal, 2),
    taxTotal: round(taxTotal, 2),
    total: round(subtotal + taxTotal, 2),
  };
}

export interface ReceiptLine {
  id: string;
  qty: number;
  qtyReceived: number;
}

export interface ReceiptPlan {
  /** Por línea: lo que entra ahora (> 0) y su nuevo acumulado. */
  receive: Array<{ id: string; qty: number; qtyReceived: number }>;
  status: Extract<PoStatus, 'recibida_parcial' | 'recibida'>;
  /** Errores en español; si hay, no se recibe nada. */
  errors: string[];
}

/**
 * Qué entra con una recepción. Sin cantidades explícitas = todo lo pendiente.
 * Recibir más de lo pendiente de una línea es un error (la orden pidió eso; si
 * llegó de más, se ajusta la orden o se registra una entrada aparte).
 */
export function planReceipt(
  lines: readonly ReceiptLine[],
  requested?: ReadonlyMap<string, number> | null,
): ReceiptPlan {
  const errors: string[] = [];
  const receive: ReceiptPlan['receive'] = [];
  for (const l of lines) {
    const pending = round(l.qty - l.qtyReceived, 4);
    const want = requested ? (requested.get(l.id) ?? 0) : pending;
    if (want < 0) errors.push('Una cantidad recibida no puede ser negativa.');
    else if (want > pending + 1e-9)
      errors.push(
        `Una línea pide ${formatQty(l.qty)} y ya llegaron ${formatQty(l.qtyReceived)}: no caben ${formatQty(want)} más.`,
      );
    else if (want > 0)
      receive.push({ id: l.id, qty: want, qtyReceived: round(l.qtyReceived + want, 4) });
  }
  if (requested) {
    const known = new Set(lines.map((l) => l.id));
    for (const id of requested.keys())
      if (!known.has(id)) errors.push('Una de las líneas no es de esta orden.');
  }
  if (!errors.length && receive.length === 0) errors.push('No hay nada pendiente por recibir.');
  const after = new Map(receive.map((r) => [r.id, r.qtyReceived]));
  const complete = lines.every((l) => (after.get(l.id) ?? l.qtyReceived) >= l.qty - 1e-9);
  return {
    receive: errors.length ? [] : receive,
    status: complete ? 'recibida' : 'recibida_parcial',
    errors,
  };
}

/** El vencimiento esperado del pago de una orden: llegada + plazo. */
export function expectedPaymentDue(input: {
  approvedOn: string;
  expectedOn: string | null;
  termsDays: number;
}): string {
  const base =
    input.expectedOn && input.expectedOn > input.approvedOn ? input.expectedOn : input.approvedOn;
  return addDaysIso(base, input.termsDays);
}
