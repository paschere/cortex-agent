import {
  LOST_REASON_LABEL,
  type LostReasonKind,
  type OpportunityRow,
  type StageDef,
  stageOf,
} from './shape';

/**
 * EL ANÁLISIS COMERCIAL (migración 0193) — puro.
 *
 *   conversión   cotizaciones ganadas sobre las decididas (ganadas + rechazadas
 *                + vencidas), por responsable, por producto y por mes. Las
 *                que siguen abiertas no cuentan ni a favor ni en contra: se
 *                dicen aparte.
 *   ciclo        días de la oportunidad creada a ganada, y de la cotización
 *                enviada a aceptada (mediana y promedio).
 *   pérdidas     por qué se pierde (razón y plata) y la tasa de cierre.
 *   ticket       valor promedio de lo ganado en 12 meses.
 *   márgenes     por cliente y por producto: precio neto contra el costo del
 *                inventario (0183) cuando el producto lo tiene. Lo que no
 *                tiene costo no se inventa: se dice qué parte de la venta sí
 *                se pudo medir (`coverage`).
 *
 * Todo en pesos: otras monedas se cuentan pero no se suman.
 */

// ---------------------------------------------------------------------------
// Entradas
// ---------------------------------------------------------------------------

export interface QuoteLineIn {
  description: string;
  productCode: string | null;
  productRef: string | null;
  quantity: number;
  unitPrice: number;
  discountPct: number;
  /** Base neta (después de descuento, antes de IVA). */
  base: number;
}

export interface QuoteIn {
  id: string;
  createdBy: string | null;
  issueDate: string;
  status: string;
  validUntil: string | null;
  sentAt: string | null;
  acceptedAt: string | null;
  currency: string;
  total: number;
  lines: QuoteLineIn[];
}

/** Un documento que cuenta como venta: pedido, cotización aceptada sin pedido o factura directa. */
export interface SaleIn {
  id: string;
  clientId: string | null;
  clientName: string;
  issueDate: string;
  currency: string;
  lines: QuoteLineIn[];
}

export interface ProductCost {
  sku: string | null;
  sourceRef: string | null;
  name: string;
  cost: number | null;
}

// ---------------------------------------------------------------------------
// Conversión
// ---------------------------------------------------------------------------

export type QuoteOutcome = 'won' | 'lost' | 'open' | 'draft' | 'void';

const WON = new Set(['aceptada', 'pedido', 'facturada']);

export function quoteOutcome(
  q: Pick<QuoteIn, 'status' | 'validUntil'>,
  today: string,
): QuoteOutcome {
  if (WON.has(q.status)) return 'won';
  if (q.status === 'anulada') return 'void';
  if (q.status === 'rechazada' || q.status === 'vencida') return 'lost';
  if (q.validUntil && q.validUntil < today && (q.status === 'enviada' || q.status === 'borrador'))
    return q.status === 'borrador' ? 'void' : 'lost';
  if (q.status === 'borrador') return 'draft';
  return 'open';
}

export interface ConversionRow {
  key: string;
  label: string;
  won: number;
  lost: number;
  open: number;
  wonValue: number;
  /** won / (won + lost); null si nada se ha decidido. */
  rate: number | null;
}

function emptyRow(key: string, label: string): ConversionRow {
  return { key, label, won: 0, lost: 0, open: 0, wonValue: 0, rate: null };
}

function finish(rows: Map<string, ConversionRow>): ConversionRow[] {
  return [...rows.values()]
    .map((r) => ({ ...r, rate: r.won + r.lost > 0 ? r.won / (r.won + r.lost) : null }))
    .sort((a, b) => b.won + b.lost + b.open - (a.won + a.lost + a.open));
}

function productKey(l: QuoteLineIn): { key: string; label: string } {
  const code = l.productCode?.trim();
  const label = l.description.trim().split('\n')[0]?.slice(0, 80) || 'Sin descripción';
  return { key: code ? `c:${code.toLowerCase()}` : `d:${label.toLowerCase()}`, label };
}

export interface ConversionReport {
  overall: ConversionRow;
  byOwner: ConversionRow[];
  byProduct: ConversionRow[];
  byMonth: ConversionRow[];
}

export function quoteConversion(
  quotes: readonly QuoteIn[],
  opts: { today: string; ownerName: (id: string | null) => string },
): ConversionReport {
  const overall = emptyRow('all', 'Todas');
  const owners = new Map<string, ConversionRow>();
  const products = new Map<string, ConversionRow>();
  const months = new Map<string, ConversionRow>();
  const bump = (row: ConversionRow, outcome: QuoteOutcome, value: number) => {
    if (outcome === 'won') {
      row.won += 1;
      row.wonValue += value;
    } else if (outcome === 'lost') row.lost += 1;
    else if (outcome === 'open') row.open += 1;
  };
  for (const q of quotes) {
    const outcome = quoteOutcome(q, opts.today);
    if (outcome === 'draft' || outcome === 'void') continue;
    const value = q.currency === 'COP' ? q.total : 0;
    bump(overall, outcome, value);
    const ownerKey = q.createdBy ?? 'none';
    if (!owners.has(ownerKey))
      owners.set(ownerKey, emptyRow(ownerKey, opts.ownerName(q.createdBy)));
    bump(owners.get(ownerKey) as ConversionRow, outcome, value);
    const month = q.issueDate.slice(0, 7);
    if (!months.has(month)) months.set(month, emptyRow(month, month));
    bump(months.get(month) as ConversionRow, outcome, value);
    // Un producto cuenta una vez por cotización, con el valor de sus líneas.
    const seen = new Map<string, { label: string; value: number }>();
    for (const l of q.lines) {
      const p = productKey(l);
      const prev = seen.get(p.key);
      seen.set(p.key, {
        label: p.label,
        value: (prev?.value ?? 0) + (q.currency === 'COP' ? l.base : 0),
      });
    }
    for (const [key, p] of seen) {
      if (!products.has(key)) products.set(key, emptyRow(key, p.label));
      bump(products.get(key) as ConversionRow, outcome, p.value);
    }
  }
  overall.rate = overall.won + overall.lost > 0 ? overall.won / (overall.won + overall.lost) : null;
  return {
    overall,
    byOwner: finish(owners),
    byProduct: finish(products).slice(0, 20),
    byMonth: finish(months).sort((a, b) => a.key.localeCompare(b.key)),
  };
}

// ---------------------------------------------------------------------------
// Ciclo, pérdidas y ticket
// ---------------------------------------------------------------------------

export interface CycleStats {
  count: number;
  medianDays: number | null;
  averageDays: number | null;
}

function cycle(values: number[]): CycleStats {
  if (values.length === 0) return { count: 0, medianDays: null, averageDays: null };
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  const med = s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
  return {
    count: values.length,
    medianDays: Math.round(med),
    averageDays: Math.round(values.reduce((a, b) => a + b, 0) / values.length),
  };
}

const dayDiff = (from: string, to: string) =>
  Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000));

export interface WinLossReport {
  /** Ganadas / (ganadas + perdidas) de las oportunidades cerradas. */
  winRate: number | null;
  won: { count: number; value: number };
  lost: { count: number; value: number };
  reasons: Array<{
    kind: LostReasonKind | 'sin_razon';
    label: string;
    count: number;
    value: number;
  }>;
  /** Ciclo de venta: creada → ganada. */
  opportunityCycle: CycleStats;
  /** Cotización enviada → aceptada. */
  quoteCycle: CycleStats;
  /** Valor promedio de lo ganado en 12 meses (pesos). */
  averageDeal: number | null;
  /** Lo ganado en 12 meses por etapa de origen no aplica; por origen sí. */
  bySource: Array<{ source: string; won: number; lost: number; value: number }>;
}

export function winLoss(
  opps: readonly OpportunityRow[],
  quotes: readonly QuoteIn[],
  stages: readonly StageDef[],
  today: string,
): WinLossReport {
  const since = new Date(Date.parse(`${today}T00:00:00Z`) - 365 * 86_400_000).toISOString();
  const won = { count: 0, value: 0 };
  const lost = { count: 0, value: 0 };
  const reasons = new Map<
    string,
    { kind: LostReasonKind | 'sin_razon'; label: string; count: number; value: number }
  >();
  const cycles: number[] = [];
  const dealValues: number[] = [];
  const sources = new Map<string, { source: string; won: number; lost: number; value: number }>();
  for (const o of opps) {
    const role = stageOf(stages, o.stage)?.role;
    const cop = o.currency === 'COP' ? o.value : 0;
    const src = sources.get(o.source) ?? { source: o.source, won: 0, lost: 0, value: 0 };
    if (role === 'won' && o.won_at) {
      won.count += 1;
      won.value += cop;
      src.won += 1;
      src.value += cop;
      cycles.push(dayDiff(o.created_at, o.won_at));
      if (o.won_at >= since && o.currency === 'COP') dealValues.push(o.value);
    } else if (role === 'lost') {
      lost.count += 1;
      lost.value += cop;
      src.lost += 1;
      const kind = o.lost_reason_kind ?? 'sin_razon';
      const r = reasons.get(kind) ?? {
        kind,
        label: kind === 'sin_razon' ? 'Sin razón anotada' : LOST_REASON_LABEL[kind],
        count: 0,
        value: 0,
      };
      r.count += 1;
      r.value += cop;
      reasons.set(kind, r);
    } else continue;
    sources.set(o.source, src);
  }
  const quoteCycles = quotes
    .filter((q) => q.sentAt && q.acceptedAt)
    .map((q) => dayDiff(q.sentAt as string, q.acceptedAt as string));
  return {
    winRate: won.count + lost.count > 0 ? won.count / (won.count + lost.count) : null,
    won,
    lost,
    reasons: [...reasons.values()].sort((a, b) => b.count - a.count || b.value - a.value),
    opportunityCycle: cycle(cycles),
    quoteCycle: cycle(quoteCycles),
    averageDeal: dealValues.length
      ? Math.round(dealValues.reduce((a, b) => a + b, 0) / dealValues.length)
      : null,
    bySource: [...sources.values()].sort((a, b) => b.won - a.won),
  };
}

// ---------------------------------------------------------------------------
// Precios y márgenes
// ---------------------------------------------------------------------------

export interface MarginRow {
  key: string;
  label: string;
  revenue: number;
  /** Venta de las líneas que tienen costo. */
  revenueWithCost: number;
  cost: number;
  /** (revenueWithCost − cost) / revenueWithCost; null sin costo. */
  margin: number | null;
  /** Qué parte de la venta tiene costo (0–1). */
  coverage: number;
  /** Descuento promedio ponderado (puntos). */
  avgDiscount: number;
  quantity: number;
  /** Producto: precio unitario neto promedio, mínimo y máximo. */
  avgPrice?: number;
  minPrice?: number;
  maxPrice?: number;
}

export interface MarginReport {
  byClient: MarginRow[];
  byProduct: MarginRow[];
  totals: {
    revenue: number;
    revenueWithCost: number;
    cost: number;
    margin: number | null;
    coverage: number;
  };
  /** Por qué no hay márgenes, si no los hay. */
  note: string | null;
}

export function costIndex(products: readonly ProductCost[]) {
  const bySku = new Map<string, number>();
  const byRef = new Map<string, number>();
  for (const p of products) {
    if (p.cost == null || !(p.cost >= 0)) continue;
    if (p.sku) bySku.set(p.sku.trim().toLowerCase(), p.cost);
    if (p.sourceRef) byRef.set(p.sourceRef.trim(), p.cost);
  }
  return (l: Pick<QuoteLineIn, 'productCode' | 'productRef'>): number | null => {
    if (l.productCode) {
      const c = bySku.get(l.productCode.trim().toLowerCase());
      if (c !== undefined) return c;
    }
    if (l.productRef) {
      const c = byRef.get(l.productRef.trim());
      if (c !== undefined) return c;
    }
    return null;
  };
}

interface Acc {
  key: string;
  label: string;
  revenue: number;
  revenueWithCost: number;
  cost: number;
  gross: number;
  discount: number;
  quantity: number;
  prices: number[];
}

function acc(key: string, label: string): Acc {
  return {
    key,
    label,
    revenue: 0,
    revenueWithCost: 0,
    cost: 0,
    gross: 0,
    discount: 0,
    quantity: 0,
    prices: [],
  };
}

function toRow(a: Acc, withPrices: boolean): MarginRow {
  const row: MarginRow = {
    key: a.key,
    label: a.label,
    revenue: Math.round(a.revenue),
    revenueWithCost: Math.round(a.revenueWithCost),
    cost: Math.round(a.cost),
    margin: a.revenueWithCost > 0 ? (a.revenueWithCost - a.cost) / a.revenueWithCost : null,
    coverage: a.revenue > 0 ? a.revenueWithCost / a.revenue : 0,
    avgDiscount: a.gross > 0 ? Math.round((a.discount / a.gross) * 1000) / 10 : 0,
    quantity: a.quantity,
  };
  if (withPrices && a.quantity > 0) {
    row.avgPrice = Math.round(a.revenue / a.quantity);
    row.minPrice = Math.round(Math.min(...a.prices));
    row.maxPrice = Math.round(Math.max(...a.prices));
  }
  return row;
}

export function margins(sales: readonly SaleIn[], products: readonly ProductCost[]): MarginReport {
  const costOf = costIndex(products);
  const clients = new Map<string, Acc>();
  const items = new Map<string, Acc>();
  const total = acc('all', 'Todo');
  let anyCost = false;
  for (const s of sales) {
    if (s.currency !== 'COP') continue;
    const ck = s.clientId ?? `n:${s.clientName.toLowerCase()}`;
    const c = clients.get(ck) ?? acc(ck, s.clientName);
    clients.set(ck, c);
    for (const l of s.lines) {
      const p = productKey(l);
      const it = items.get(p.key) ?? acc(p.key, p.label);
      items.set(p.key, it);
      const unitCost = costOf(l);
      const gross = l.quantity * l.unitPrice;
      const net = l.base;
      for (const a of [c, it, total]) {
        a.revenue += net;
        a.gross += gross;
        a.discount += gross - net;
        a.quantity += l.quantity;
        if (unitCost !== null) {
          a.revenueWithCost += net;
          a.cost += unitCost * l.quantity;
        }
      }
      if (unitCost !== null) anyCost = true;
      if (l.quantity > 0) it.prices.push(net / l.quantity);
    }
  }
  const t = toRow(total, false);
  return {
    byClient: [...clients.values()]
      .map((a) => toRow(a, false))
      .sort((a, b) => b.revenue - a.revenue),
    byProduct: [...items.values()].map((a) => toRow(a, true)).sort((a, b) => b.revenue - a.revenue),
    totals: {
      revenue: t.revenue,
      revenueWithCost: t.revenueWithCost,
      cost: t.cost,
      margin: t.margin,
      coverage: t.coverage,
    },
    note:
      sales.length === 0
        ? 'Todavía no hay pedidos ni cotizaciones aceptadas en Ventas para medir precios y márgenes.'
        : anyCost
          ? null
          : 'Ningún producto vendido tiene costo: con el inventario (costo promedio) o el costo en el catálogo, aquí sale el margen. Por ahora sólo se ven precios y descuentos.',
  };
}
