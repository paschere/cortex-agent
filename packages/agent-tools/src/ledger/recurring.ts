/**
 * LO QUE SE REPITE: NÓMINA EL 30, ARRIENDO EL 5, LA PILA, LOS SERVICIOS.
 *
 * Trece semanas de caja son, sobre todo, los gastos de siempre. Nadie los
 * registra como «por pagar» con meses de anticipación, así que se infieren del
 * historial liquidado (extractos, pagos, contabilidad).
 *
 * CÓMO SE DETECTA, Y POR QUÉ ES CONSERVADOR:
 *
 *   1. Sólo lo liquidado de los últimos ~13 meses, sin traslados entre cuentas
 *      propias ni facturas por cobrar (cuándo entra un cobro lo decide el
 *      cliente, no el calendario; eso lo modela `behavior.ts`, y una venta que
 *      todavía no se ha facturado no se inventa).
 *   2. Se agrupa por contraparte (NIT o nombre) o, si no hay, por categoría y
 *      «firma» de la descripción («Pago nómina quincena 2 sept» = «Pago nómina
 *      quincena 1 oct»). Dentro del grupo se separan montos muy distintos (la
 *      energía y el acueducto de EPM son dos cosas).
 *   3. Semanal: al menos 3 veces, con ~7 días entre una y otra.
 *      Mensual: al menos 3 meses con el pago cerca del mismo día (±6 días; el 30
 *      y el 1 son vecinos), en meses casi seguidos. La quincena sale como dos
 *      mensuales: la del 15 y la del 30.
 *   4. Tiene que seguir vivo: la última vez hace menos de 45 días (mensual) o
 *      14 (semanal). Lo bimestral, lo anual y lo irregular NO se proyecta.
 *   5. Monto = mediana de las tres últimas veces; si los montos saltan más de
 *      35% en un tercio de las veces, no es recurrente.
 *
 * LO DECLARADO SE SUMA, NO REEMPLAZA. Lo que una persona declara («el crédito
 * de Bancolombia, 2 M el 28») se junta con lo detectado (`mergeRecurring`). Si
 * los dos hablan de lo mismo —misma contraparte, o misma categoría sin
 * contraparte, mismo sentido y periodicidad, día parecido— manda lo declarado.
 * Cada detectado lleva una `detectedKey` estable (contraparte o firma,
 * periodicidad y día) para que confirmarlo o ignorarlo valga en la próxima
 * corrida aunque el historial avance.
 *
 * Que un pago ya esté registrado como factura por pagar en el horizonte no se
 * resuelve aquí sino en la proyección, ocurrencia por ocurrencia: el arriendo
 * de octubre ya facturado no se cuenta dos veces, pero el de noviembre y
 * diciembre sí se proyecta.
 */

import {
  addDays,
  categoryKey,
  categoryLabel,
  cleanDescription,
  daysBetween,
  descriptionSignature,
  isoWeekday,
  makeKeyResolver,
  median,
  monthIndex,
  stableHash,
  toDay,
  weekdayName,
} from './forecast-shared';
import type { LedgerDirection, LedgerMovement, RecurringFlow } from './types';

export const MIN_OCCURRENCES = 3;
export const LOOKBACK_DAYS = 400;
export const AMOUNT_TOLERANCE = 0.35;
/** Dos montos del mismo grupo más separados que esto son cosas distintas. */
const BAND_RATIO = 1.5;
const MONTHLY_GAP = 3;
const MONTHLY_SPREAD = 6;
const MONTHLY_STALE_DAYS = 45;
const WEEKLY_STALE_DAYS = 14;

export interface DetectOptions {
  /** Cuánta historia mirar hacia atrás. Por defecto ~13 meses. */
  lookbackDays?: number;
  /** Ocurrencias mínimas. Por defecto 3; nunca menos de 3. */
  minOccurrences?: number;
}

interface Occurrence {
  day: string;
  amount: number;
  movement: LedgerMovement;
}

interface Group {
  key: string;
  direction: LedgerDirection;
  currency: string;
  hasCounterparty: boolean;
  occurrences: Occurrence[];
}

interface Candidate {
  every: 'week' | 'month';
  anchor: number;
  amount: number;
  sample: number;
  occurrences: Occurrence[];
}

function byDay(a: Occurrence, b: Occurrence): number {
  if (a.day !== b.day) return a.day < b.day ? -1 : 1;
  return a.movement.id < b.movement.id ? -1 : a.movement.id > b.movement.id ? 1 : 0;
}

/** Separa montos muy distintos dentro de un mismo grupo. */
function amountBands(occurrences: Occurrence[]): Occurrence[][] {
  const sorted = [...occurrences].sort((a, b) => a.amount - b.amount || byDay(a, b));
  const bands: Occurrence[][] = [];
  let current: Occurrence[] = [];
  for (const o of sorted) {
    const prev = current[current.length - 1];
    if (prev && o.amount > prev.amount * BAND_RATIO) {
      bands.push(current);
      current = [];
    }
    current.push(o);
  }
  if (current.length) bands.push(current);
  return bands.map((b) => b.sort(byDay));
}

function amountsAreStable(amounts: number[]): boolean {
  const mid = median(amounts);
  if (mid <= 0) return false;
  const within = amounts.filter((a) => Math.abs(a - mid) <= mid * AMOUNT_TOLERANCE).length;
  return within >= Math.ceil((amounts.length * 2) / 3);
}

function recentMedian(amounts: number[]): number {
  return Math.round(median(amounts.slice(-3)));
}

function tryWeekly(occ: Occurrence[], asOf: string, min: number): Candidate | null {
  if (occ.length < min) return null;
  const intervals: number[] = [];
  for (let i = 1; i < occ.length; i++) {
    intervals.push(daysBetween((occ[i - 1] as Occurrence).day, (occ[i] as Occurrence).day));
  }
  const weekly = intervals.filter((d) => d >= 5 && d <= 9).length;
  const mid = median(intervals);
  if (mid < 6 || mid > 8 || weekly < intervals.length * 0.75) return null;
  const last = occ[occ.length - 1] as Occurrence;
  if (daysBetween(last.day, asOf) > WEEKLY_STALE_DAYS) return null;
  const amounts = occ.map((o) => o.amount);
  if (!amountsAreStable(amounts)) return null;
  const counts = new Map<number, number>();
  for (const o of occ) counts.set(isoWeekday(o.day), (counts.get(isoWeekday(o.day)) ?? 0) + 1);
  let anchor = 1;
  let best = -1;
  for (let d = 1; d <= 7; d++) {
    const c = counts.get(d) ?? 0;
    if (c > best) {
      best = c;
      anchor = d;
    }
  }
  return {
    every: 'week',
    anchor,
    amount: recentMedian(amounts),
    sample: occ.length,
    occurrences: occ,
  };
}

/** Posición en el mes, con el 31 tratado como 30 («fin de mes»). */
function position(day: string): number {
  return Math.min(Number(day.slice(8, 10)), 30);
}

function monthlyClusters(occ: Occurrence[]): Array<{ items: Occurrence[]; wrap: boolean }> {
  const sorted = [...occ].sort((a, b) => position(a.day) - position(b.day) || byDay(a, b));
  const clusters: Array<{ items: Occurrence[]; wrap: boolean }> = [];
  let current: Occurrence[] = [];
  for (const o of sorted) {
    const prev = current[current.length - 1];
    if (prev && position(o.day) - position(prev.day) > MONTHLY_GAP) {
      clusters.push({ items: current, wrap: false });
      current = [];
    }
    current.push(o);
  }
  if (current.length) clusters.push({ items: current, wrap: false });
  // El 29 y el 2 son vecinos: el primer grupo y el último se juntan.
  if (clusters.length >= 2) {
    const first = clusters[0] as { items: Occurrence[]; wrap: boolean };
    const last = clusters[clusters.length - 1] as { items: Occurrence[]; wrap: boolean };
    const firstMin = position((first.items[0] as Occurrence).day);
    const lastMax = position((last.items[last.items.length - 1] as Occurrence).day);
    if (firstMin + 30 - lastMax <= MONTHLY_GAP) {
      clusters.pop();
      clusters[0] = { items: [...last.items, ...first.items], wrap: true };
    }
  } else if (clusters.length === 1) {
    const only = clusters[0] as { items: Occurrence[]; wrap: boolean };
    const min = position((only.items[0] as Occurrence).day);
    const max = position((only.items[only.items.length - 1] as Occurrence).day);
    if (min <= MONTHLY_GAP && max >= 30 - MONTHLY_GAP) only.wrap = true;
  }
  return clusters;
}

function tryMonthly(
  cluster: { items: Occurrence[]; wrap: boolean },
  asOf: string,
  min: number,
): Candidate | null {
  const values = cluster.items.map((o) => {
    const p = position(o.day);
    return cluster.wrap && p < 15 ? p + 30 : p;
  });
  const center = Math.round(median(values));
  if (values.some((v) => Math.abs(v - center) > MONTHLY_SPREAD)) return null;
  const anchor = ((center - 1) % 30) + 1;

  // Cada pago cae en su «ciclo»: el mes al que pertenece aunque se corra un
  // par de días (el pago del 30 hecho el 1 es del mes anterior).
  const cycles = new Map<number, { amount: number; day: string }>();
  for (const o of cluster.items) {
    const cycle = monthIndex(addDays(o.day, 15 - anchor));
    const prev = cycles.get(cycle);
    // Dos pagos en el mismo ciclo y la misma banda: se suman (pago partido).
    cycles.set(cycle, {
      amount: (prev?.amount ?? 0) + o.amount,
      day: prev && prev.day > o.day ? prev.day : o.day,
    });
  }
  const keys = [...cycles.keys()].sort((a, b) => a - b);
  if (keys.length < min) return null;
  const span = (keys[keys.length - 1] as number) - (keys[0] as number) + 1;
  if (keys.length / span < 0.75) return null;
  const lastDay = cluster.items.reduce((acc, o) => (o.day > acc ? o.day : acc), '');
  if (daysBetween(lastDay, asOf) > MONTHLY_STALE_DAYS) return null;
  const amounts = keys.map((k) => (cycles.get(k) as { amount: number }).amount);
  if (!amountsAreStable(amounts)) return null;
  return {
    every: 'month',
    anchor,
    amount: recentMedian(amounts),
    sample: keys.length,
    occurrences: [...cluster.items].sort(byDay),
  };
}

function mostCommon(values: Array<string | null | undefined>): string | null {
  const counts = new Map<string, number>();
  for (const v of values) if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: string | null = null;
  let bestCount = 0;
  for (const [v, c] of counts) {
    if (c > bestCount) {
      best = v;
      bestCount = c;
    }
  }
  return best;
}

function labelFor(
  group: Group,
  occ: Occurrence[],
): { label: string; counterpartyName: string | null } {
  const latest = [...occ].sort(byDay).reverse();
  const category = mostCommon(latest.map((o) => o.movement.category));
  if (group.hasCounterparty) {
    const name = latest.find((o) => o.movement.counterpartyName)?.movement.counterpartyName ?? null;
    const shown = name?.trim() || latest[0]?.movement.counterpartyTaxId?.trim() || 'Contraparte';
    return {
      label: category ? `${categoryLabel(categoryKey(category))} · ${shown}` : shown,
      counterpartyName: name?.trim() || null,
    };
  }
  const description = latest[0]?.movement.description ?? '';
  const cleaned = cleanDescription(description);
  return {
    label: cleaned || (category ? categoryLabel(categoryKey(category)) : 'Movimiento recurrente'),
    counterpartyName: null,
  };
}

/**
 * Los gastos e ingresos que se repiten, inferidos del historial liquidado.
 * Ordenados: primero salidas, de mayor a menor monto.
 */
export function detectRecurring(
  movements: readonly LedgerMovement[],
  asOf: string,
  options: DetectOptions = {},
): RecurringFlow[] {
  const today = toDay(asOf);
  const lookback = options.lookbackDays ?? LOOKBACK_DAYS;
  const min = Math.max(MIN_OCCURRENCES, options.minOccurrences ?? MIN_OCCURRENCES);
  const resolve = makeKeyResolver(
    movements.map((m) => ({ name: m.counterpartyName, taxId: m.counterpartyTaxId })),
  );

  const groups = new Map<string, Group>();
  for (const m of movements) {
    if (m.status !== 'settled' || m.kind === 'transfer' || m.kind === 'receivable') continue;
    if (!(m.amount > 0)) continue;
    const day = toDay(m.settledAt ?? m.date);
    if (day > today || daysBetween(day, today) > lookback) continue;
    const currency = m.currency.toUpperCase();
    const cp = resolve(m.counterpartyName, m.counterpartyTaxId);
    let key: string;
    if (cp) {
      key = `${m.direction}|${currency}|${cp}`;
    } else {
      const sig = descriptionSignature(m.description);
      const cat = categoryKey(m.category);
      if (!sig && !cat) continue;
      key = `${m.direction}|${currency}|cat:${cat}|${sig}`;
    }
    const group = groups.get(key);
    const occurrence = { day, amount: m.amount, movement: m };
    if (group) group.occurrences.push(occurrence);
    else
      groups.set(key, {
        key,
        direction: m.direction,
        currency,
        hasCounterparty: cp !== null,
        occurrences: [occurrence],
      });
  }

  const flows: RecurringFlow[] = [];
  const usedKeys = new Set<string>();
  for (const group of [...groups.values()].sort((a, b) => (a.key < b.key ? -1 : 1))) {
    if (group.occurrences.length < min) continue;
    const found: Candidate[] = [];
    for (const band of amountBands(group.occurrences)) {
      if (band.length < min) continue;
      const weekly = tryWeekly(band, today, min);
      if (weekly) {
        found.push(weekly);
        continue;
      }
      for (const cluster of monthlyClusters(band)) {
        if (cluster.items.length < min) continue;
        const monthly = tryMonthly(cluster, today, min);
        if (monthly) found.push(monthly);
      }
    }
    for (const c of found) {
      const { label, counterpartyName } = labelFor(group, c.occurrences);
      const sameKind = found.filter((f) => f.every === c.every).length;
      const suffix =
        sameKind > 1
          ? c.every === 'month'
            ? ` (día ${c.anchor})`
            : ` (${weekdayName(c.anchor)})`
          : '';
      const category = mostCommon(c.occurrences.map((o) => o.movement.category));
      // Estable entre corridas: sin la primera ocurrencia (que se corre con la
      // ventana). Dos montos del mismo grupo el mismo día llevan un sufijo.
      let detectedKey = `det-${stableHash(`${group.key}|${c.every}|${c.anchor}`)}`;
      for (let n = 2; usedKeys.has(detectedKey); n++) {
        detectedKey = `det-${stableHash(`${group.key}|${c.every}|${c.anchor}|${n}`)}`;
      }
      usedKeys.add(detectedKey);
      flows.push({
        id: `rec-${stableHash(`${group.key}|${c.every}|${c.anchor}|${c.occurrences[0]?.movement.id}`)}`,
        label: `${label}${suffix}`,
        direction: group.direction,
        amount: c.amount,
        currency: group.currency,
        every: c.every,
        anchor: c.anchor,
        category: category ?? null,
        counterpartyName,
        origin: 'detected',
        sample: c.sample,
        detectedKey,
      });
    }
  }

  return flows.sort(
    (a, b) =>
      (a.direction === b.direction ? 0 : a.direction === 'out' ? -1 : 1) ||
      b.amount - a.amount ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

/** Distancia entre dos días del mes, dando la vuelta (el 30 y el 2 están a 2). */
function anchorGap(a: number, b: number, every: 'week' | 'month'): number {
  const span = every === 'month' ? 30 : 7;
  const d = Math.abs(Math.round(a) - Math.round(b)) % span;
  return Math.min(d, span - d);
}

/**
 * Lo detectado más lo declarado. Un declarado reemplaza al detectado que habla
 * de lo mismo: la misma `detectedKey` (una persona corrigió un detectado), o
 * mismo sentido, moneda y periodicidad, el día a ±6 (mensual) o el mismo día
 * de la semana, y la misma contraparte —o, si a alguno le falta, la misma
 * categoría—. Lo demás se suma. Orden: primero lo declarado.
 */
export function mergeRecurring(
  detected: readonly RecurringFlow[],
  declared: readonly RecurringFlow[],
): RecurringFlow[] {
  const resolve = makeKeyResolver(
    [...detected, ...declared].map((f) => ({ name: f.counterpartyName, taxId: null })),
  );
  const replaced = new Set<string>();
  for (const d of declared) {
    const dKey = d.counterpartyName ? resolve(d.counterpartyName, null) : null;
    const dCat = categoryKey(d.category);
    for (const x of detected) {
      if (replaced.has(x.id)) continue;
      if (d.detectedKey && x.detectedKey && d.detectedKey === x.detectedKey) {
        replaced.add(x.id);
        continue;
      }
      if (x.direction !== d.direction || x.every !== d.every) continue;
      if (x.currency.trim().toUpperCase() !== d.currency.trim().toUpperCase()) continue;
      if (anchorGap(x.anchor, d.anchor, d.every) > (d.every === 'month' ? MONTHLY_SPREAD : 0))
        continue;
      const xKey = x.counterpartyName ? resolve(x.counterpartyName, null) : null;
      // Con contraparte en los dos lados, manda la contraparte; si a alguno le
      // falta, la categoría.
      const same = dKey && xKey ? dKey === xKey : Boolean(dCat) && categoryKey(x.category) === dCat;
      if (same) replaced.add(x.id);
    }
  }
  return [...declared, ...detected.filter((x) => !replaced.has(x.id))];
}
