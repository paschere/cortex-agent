/**
 * CÓMO PAGA CADA CLIENTE, APRENDIDO DE SUS FACTURAS.
 *
 * La proyección no pone un cobro en su vencimiento a ciegas: lo corre los días
 * que ese cliente suele demorarse y lo cuenta por la fracción que suele pagar.
 * Esas dos cifras salen de aquí, del historial de facturas por cobrar.
 *
 * QUÉ SE MIDE, POR FACTURA:
 *
 *   - Pagada (`settled`) con vencimiento y fecha de pago: atraso = días entre
 *     el vencimiento y el pago. Pagar antes cuenta como 0 (la proyección nunca
 *     adelanta un cobro: es más prudente esperar el vencimiento).
 *   - Pagada sin vencimiento: cuenta como cobrada, sin atraso medible.
 *   - Anulada (`cancelled`): NO dice nada y se ignora. Una nota crédito, una
 *     factura mal emitida y vuelta a hacer, una venta que se devolvió: nada de
 *     eso es un cliente que no paga, y contarlas como «no cobradas» castigaba
 *     a los clientes con más papeleo. Lo incobrable de verdad se ve en lo que
 *     sigue abierto y vencido.
 *   - Abierta y vencida hace más de 90 días: cuenta como NO cobrada.
 *   - Abierta y al día (o vencida hace poco): todavía no dice nada; se ignora.
 *
 * POCA HISTORIA NO ES CERTEZA. Con dos facturas, un cliente que pagó una vez
 * 40 días tarde no «paga 40 días tarde». Con menos de 5 facturas, el atraso se
 * encoge hacia el de la empresa como si hubiera 3 facturas más con el
 * comportamiento promedio (con 2 facturas pesa 40% lo suyo y 60% el
 * promedio), y la proyección lo dice en palabras. Con 5 o más manda lo suyo.
 * La tasa de cobro se suaviza SIEMPRE igual (3 facturas promedio más): seis
 * facturas pagadas de seis no prueban que la séptima se pague con certeza.
 *
 * Puro: no lee la base. Mismo historial, mismo resultado.
 */

import {
  addDays,
  daysBetween,
  makeKeyResolver,
  median,
  normalizeName,
  toDay,
} from './forecast-shared';
import type { CounterpartyBehavior, LedgerMovement } from './types';

/** Vencida y sin pagar más allá de esto: se da por no cobrada. */
export const LONG_OVERDUE_DAYS = 90;
/** Facturas «imaginarias» con el comportamiento promedio que se suman a cada cliente. */
export const SHRINK_WEIGHT = 3;
/** Por debajo de esto, la proyección avisa que hay poca historia. */
export const FEW_SAMPLES = 5;
/** Lo que se asume cobrable cuando la empresa no tiene historia alguna. */
export const DEFAULT_COLLECTION_RATE = 0.95;
/** Plazo que se asume cuando una factura no trae vencimiento. */
export const DEFAULT_TERMS_DAYS = 30;

export interface BehaviorOptions {
  /** Hoy (Bogotá). Sin él: el día más reciente del historial. */
  asOf?: string;
}

/** El cliente promedio de la empresa: el punto hacia el que se encoge cada uno. */
export interface CompanyBehavior {
  typicalDelayDays: number;
  collectionRate: number;
  /** Facturas con desenlace (cobradas o perdidas) en todo el historial. */
  sample: number;
}

interface Observation {
  key: string;
  name: string;
  taxId: string | null;
  date: string;
  delay: number | null;
  collected: boolean;
}

function latestDay(movements: readonly LedgerMovement[]): string {
  let latest = '1970-01-01';
  for (const m of movements) {
    for (const d of [m.date, m.settledAt]) {
      if (d) {
        const day = toDay(d);
        if (day > latest) latest = day;
      }
    }
  }
  return latest;
}

function observe(movements: readonly LedgerMovement[], asOf: string): Observation[] {
  const resolve = makeKeyResolver(
    movements.map((m) => ({ name: m.counterpartyName, taxId: m.counterpartyTaxId })),
  );
  const out: Observation[] = [];
  for (const m of movements) {
    if (m.kind !== 'receivable' || m.direction !== 'in') continue;
    const key = resolve(m.counterpartyName, m.counterpartyTaxId);
    if (!key) continue;
    const base = {
      key,
      name: (m.counterpartyName ?? '').trim() || (m.counterpartyTaxId ?? '').trim(),
      taxId: m.counterpartyTaxId ?? null,
      date: toDay(m.date),
    };
    if (m.status === 'settled') {
      const delay =
        m.dueDate && (m.settledAt ?? null)
          ? Math.max(0, daysBetween(toDay(m.dueDate), toDay(m.settledAt as string)))
          : null;
      out.push({ ...base, delay, collected: true });
    } else if (m.status !== 'cancelled') {
      // Una anulada no dice nada (ver la cabecera): ni cobrada ni perdida.
      const due = m.dueDate ? toDay(m.dueDate) : addDays(toDay(m.date), DEFAULT_TERMS_DAYS);
      if (daysBetween(due, asOf) > LONG_OVERDUE_DAYS) {
        out.push({ ...base, delay: null, collected: false });
      }
    }
  }
  return out;
}

function company(observations: readonly Observation[]): CompanyBehavior {
  const delays = observations.flatMap((o) => (o.delay === null ? [] : [o.delay]));
  const collected = observations.filter((o) => o.collected).length;
  const n = observations.length;
  return {
    typicalDelayDays: Math.round(median(delays)),
    collectionRate: round2(
      (collected + SHRINK_WEIGHT * DEFAULT_COLLECTION_RATE) / (n + SHRINK_WEIGHT),
    ),
    sample: n,
  };
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

/** El cliente promedio: atraso mediano de todas las facturas y tasa de cobro. */
export function companyBehavior(
  movements: readonly LedgerMovement[],
  options: BehaviorOptions = {},
): CompanyBehavior {
  const asOf = options.asOf ? toDay(options.asOf) : latestDay(movements);
  return company(observe(movements, asOf));
}

/**
 * Atraso típico y tasa de cobro de cada cliente con historia, encogidos hacia
 * el promedio de la empresa según cuántas facturas los respaldan.
 */
export function behaviorFromHistory(
  movements: readonly LedgerMovement[],
  options: BehaviorOptions = {},
): CounterpartyBehavior[] {
  const asOf = options.asOf ? toDay(options.asOf) : latestDay(movements);
  const observations = observe(movements, asOf);
  const avg = company(observations);

  const byKey = new Map<string, Observation[]>();
  for (const o of observations) {
    const list = byKey.get(o.key);
    if (list) list.push(o);
    else byKey.set(o.key, [o]);
  }

  const result: CounterpartyBehavior[] = [];
  for (const list of byKey.values()) {
    // El nombre y el NIT más recientes: así se llama hoy.
    const latest = [...list].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    const name = latest.find((o) => o.name)?.name ?? '';
    const taxId = latest.find((o) => o.taxId)?.taxId ?? null;
    const delays = list.flatMap((o) => (o.delay === null ? [] : [o.delay]));
    const n = list.length;
    const collected = list.filter((o) => o.collected).length;
    const ownDelay = median(delays);
    // El atraso sólo se encoge con poca historia: con 5 facturas o más, manda
    // lo que el cliente ha hecho (un cliente que siempre paga a tiempo no
    // «paga 5 días tarde» porque otros se demoren).
    const typicalDelayDays =
      n < FEW_SAMPLES || delays.length === 0
        ? Math.round(
            (delays.length * ownDelay + SHRINK_WEIGHT * avg.typicalDelayDays) /
              (delays.length + SHRINK_WEIGHT),
          )
        : Math.round(ownDelay);
    const collectionRate = round2(
      (collected + SHRINK_WEIGHT * avg.collectionRate) / (n + SHRINK_WEIGHT),
    );
    result.push({
      counterpartyName: name,
      counterpartyTaxId: taxId,
      typicalDelayDays,
      collectionRate,
      sample: n,
    });
  }
  return result.sort((a, b) => {
    const an = normalizeName(a.counterpartyName);
    const bn = normalizeName(b.counterpartyName);
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
}
