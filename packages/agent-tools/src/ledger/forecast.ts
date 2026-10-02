/**
 * LA CAJA DE LAS PRÓXIMAS 13 SEMANAS.
 *
 * La pregunta de todo dueño: «¿me alcanza?». La respuesta es una tabla de
 * semanas (lunes a domingo, días de Bogotá) con lo que hay hoy, lo que se
 * espera que entre y salga, y con qué queda cada semana. Cada peso de la tabla
 * dice por qué está ahí, y los supuestos se dicen en palabras: nada de caja
 * negra.
 *
 * DE DÓNDE SALE CADA LÍNEA:
 *
 *   - CAJA INICIAL: la suma de los saldos de las cuentas en la moneda pedida.
 *     Las de otra moneda se dejan por fuera, y se dice.
 *   - COBROS (facturas por cobrar abiertas, por su saldo pendiente): en su
 *     vencimiento más el atraso típico del cliente, contados por la fracción
 *     que ese cliente suele pagar (`behavior.ts`). Lo que ya va más tarde de lo
 *     que el cliente suele demorarse se reparte en las próximas semanas y
 *     pierde probabilidad: 90 días después de su atraso típico cuenta la mitad.
 *   - PAGOS (facturas por pagar abiertas): el día que vencen. Las vencidas, esta
 *     semana, con la nota de que siguen sin pagar. Las que llevan más de 60
 *     días vencidas sin un pago del banco que coincida (el libro las salda solo
 *     cuando lo encuentra, `payables.ts`) se marcan «¿ya la pagaste?» y pierden
 *     probabilidad: no se cuentan enteras para siempre.
 *   - LO QUE SE REPITE (`recurring.ts` más lo declarado): cada ocurrencia en el
 *     horizonte, salvo la que ya está como factura en el libro (no se cuenta
 *     dos veces). Si un gasto fijo debía pasar hace pocos días y no aparece
 *     pagado, se cuenta esta semana. Lo que una persona ignoró no entra.
 *   - VENTAS ESTIMADAS (si `includeEstimatedSales`, por defecto sí): a cada
 *     cliente que factura casi todos los meses (3 o más de los últimos 6) se le
 *     proyecta lo que falta facturar al ritmo de su promedio mensual, cobrado
 *     con su plazo y su atraso típico, y contado con menos probabilidad que una
 *     factura de verdad. Cada línea dice que es una estimación.
 *   - EL ESCENARIO (`scenario.ts`), si lo hay, sobre todo lo anterior.
 *
 * Puro y determinista: no lee la base ni el reloj. `asOf` es hoy. Montos en
 * pesos enteros (o unidades enteras de la moneda).
 */

import {
  type CompanyBehavior,
  DEFAULT_COLLECTION_RATE,
  DEFAULT_TERMS_DAYS,
  FEW_SAMPLES,
  behaviorFromHistory,
  companyBehavior,
} from './behavior';
import {
  type DraftItem,
  addDays,
  categoryKey,
  clamp,
  dayOfMonth,
  daysBetween,
  descriptionSignature,
  formatDay,
  formatMoney,
  formatPct,
  isoWeekday,
  makeKeyResolver,
  mondayOf,
  monthIndex,
  plural,
  stableHash,
  toDay,
  weekdayName,
} from './forecast-shared';
import { AMOUNT_TOLERANCE, detectRecurring, mergeRecurring } from './recurring';
import { applyScenario, describeScenario } from './scenario';
import type {
  CounterpartyBehavior,
  ForecastAlert,
  ForecastInput,
  ForecastItem,
  ForecastResult,
  ForecastWeek,
  LedgerMovement,
  RecurringFlow,
} from './types';

export const DEFAULT_HORIZON_WEEKS = 13;
/** Días por encima del atraso típico en que un cobro vencido pierde la mitad. */
export const OVERDUE_HALF_LIFE_DAYS = 90;
/** Un cliente con más de esta fracción de lo que se espera cobrar es concentración. */
export const CONCENTRATION_SHARE = 0.4;
export const LATE_PAYER_DAYS = 30;
export const LATE_PAYER_RATE = 0.75;
export const STALE_BALANCE_DAYS = 7;
/** Un gasto fijo que debía pasar hasta hace estos días y no aparece: esta semana. */
export const MISSED_RECURRING_GRACE_DAYS = 5;
const COVER_WINDOW_DAYS = { month: 12, week: 3 } as const;
/** Una factura por pagar vencida hace más de esto, sin pago que coincida: «¿ya la pagaste?». */
export const STALE_PAYABLE_DAYS = 60;
/** Cada cuántos días más de vencida pierde la mitad lo que se cuenta de ella. */
export const STALE_PAYABLE_HALF_LIFE_DAYS = 60;
/** Meses de historia que miran las ventas estimadas, y cuántos con factura hacen falta. */
export const ESTIMATE_WINDOW_MONTHS = 6;
export const ESTIMATE_MIN_MONTHS = 3;
/** Una venta estimada cuenta esta fracción de lo que el cliente suele pagar. */
export const ESTIMATE_PROBABILITY_FACTOR = 0.6;

// ---------------------------------------------------------------------------
// Piezas
// ---------------------------------------------------------------------------

/** «Nexa Logística S.A.S.» → «Nexa Logística»: así se habla. */
export function shortName(name: string): string {
  return (
    name
      .trim()
      .replace(/[\s,]+(s\.?\s?a\.?\s?s\.?|ltda\.?|limitada|s\.?\s?a\.?|e\.?\s?s\.?\s?p\.?)$/i, '')
      .trim() || name.trim()
  );
}

function payPhrase(delay: number): string {
  if (delay <= 0) return 'pagar a tiempo';
  return `pagar ${delay} ${delay === 1 ? 'día' : 'días'} tarde`;
}

/** Lo que el libro tiene, reducido a lo que sirve para no contar dos veces. */
interface CoverRecord {
  direction: 'in' | 'out';
  key: string | null;
  category: string;
  signature: string;
  amount: number;
  date: string;
  used: boolean;
}

function sharesToken(a: string, b: string): boolean {
  if (!a || !b) return false;
  const set = new Set(b.split(' '));
  return a.split(' ').some((t) => t.length > 2 && set.has(t));
}

function flowMatches(
  flow: RecurringFlow,
  flowKey: string | null,
  rec: Omit<CoverRecord, 'used' | 'date'>,
): boolean {
  if (rec.direction !== flow.direction) return false;
  if (Math.abs(rec.amount - flow.amount) > flow.amount * AMOUNT_TOLERANCE) return false;
  if (flowKey) return rec.key === flowKey;
  const cat = categoryKey(flow.category);
  if (cat && rec.category && cat !== rec.category) return false;
  const sig = descriptionSignature(flow.label);
  if (sig) return sharesToken(sig, rec.signature);
  return Boolean(cat) && rec.category === cat;
}

function movementLabel(m: LedgerMovement): string {
  const name = m.counterpartyName?.trim() ? shortName(m.counterpartyName) : '';
  const desc = m.description.trim();
  let label: string;
  if (m.kind === 'receivable' || m.kind === 'payable') {
    const verb = m.direction === 'in' ? 'Cobro a' : 'Pago a';
    if (name) {
      const showDesc = desc && !desc.toLowerCase().includes(name.toLowerCase());
      label = showDesc ? `${verb} ${name} · ${desc}` : `${verb} ${name}`;
    } else {
      label = `${m.direction === 'in' ? 'Cobro' : 'Pago'}: ${desc || 'sin descripción'}`;
    }
  } else {
    label = desc || name || (m.direction === 'in' ? 'Ingreso' : 'Gasto');
    if (name && desc && !desc.toLowerCase().includes(name.toLowerCase()))
      label = `${desc} · ${name}`;
  }
  return label.length > 90 ? `${label.slice(0, 89)}…` : label;
}

function monthlyDates(anchor: number, from: string, to: string): string[] {
  const out: string[] = [];
  for (let mi = monthIndex(from); mi <= monthIndex(to); mi++) {
    const d = dayOfMonth(Math.floor(mi / 12), (mi % 12) + 1, anchor);
    if (d >= from && d <= to) out.push(d);
  }
  return out;
}

function weeklyDates(weekday: number, from: string, to: string): string[] {
  const out: string[] = [];
  const shift = (((Math.round(weekday) - isoWeekday(from)) % 7) + 7) % 7;
  for (let d = addDays(from, shift); d <= to; d = addDays(d, 7)) out.push(d);
  return out;
}

const SEVERITY_RANK = { critical: 0, warn: 1, info: 2 } as const;

// ---------------------------------------------------------------------------
// La proyección
// ---------------------------------------------------------------------------

export function forecast(input: ForecastInput): ForecastResult {
  const asOf = toDay(input.asOf);
  const currency = input.currency.trim().toUpperCase();
  const fm = (n: number) => formatMoney(n, currency);
  const horizonWeeks = clamp(Math.round(input.horizonWeeks ?? DEFAULT_HORIZON_WEEKS), 1, 52);
  const firstMonday = mondayOf(asOf);
  const horizonEnd = addDays(firstMonday, horizonWeeks * 7 - 1);
  const movements = input.movements ?? [];
  const assumptions: string[] = [];

  assumptions.push(
    `Semanas de lunes a domingo en días de Bogotá, del ${formatDay(firstMonday)} al ${formatDay(horizonEnd)}; la primera cuenta desde hoy, ${formatDay(asOf)}.`,
  );

  // 1. CAJA INICIAL ---------------------------------------------------------
  const accounts = input.accounts ?? [];
  const sameCurrency = accounts.filter((a) => a.currency.trim().toUpperCase() === currency);
  const otherCurrency = accounts.filter((a) => a.currency.trim().toUpperCase() !== currency);
  const startingCash = Math.round(sameCurrency.reduce((s, a) => s + a.balance, 0));
  if (accounts.length === 0) {
    assumptions.push(
      'No hay cuentas con saldo: la caja arranca en $ 0 y la tabla muestra sólo lo que entra y sale.',
    );
  } else if (sameCurrency.length === 0) {
    assumptions.push(`Ninguna cuenta está en ${currency}: la caja arranca en ${fm(0)}.`);
  } else {
    const names = sameCurrency.map((a) => a.name).join(', ');
    assumptions.push(
      `Caja inicial ${fm(startingCash)}: ${plural(sameCurrency.length, 'cuenta', 'cuentas')} en ${currency} (${names}).`,
    );
  }
  if (otherCurrency.length > 0) {
    const byCur = new Map<string, number>();
    for (const a of otherCurrency) {
      const c = a.currency.trim().toUpperCase();
      byCur.set(c, (byCur.get(c) ?? 0) + a.balance);
    }
    const listed = [...byCur.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([c, v]) => formatMoney(v, c));
    assumptions.push(
      `Quedaron por fuera ${plural(otherCurrency.length, 'cuenta', 'cuentas')} en otra moneda (${listed.join(', ')}): la proyección es sólo en ${currency}, sin convertir.`,
    );
  }
  for (const a of sameCurrency) {
    const age = daysBetween(toDay(a.balanceAt), asOf);
    if (age > STALE_BALANCE_DAYS) {
      assumptions.push(
        `El saldo de «${a.name}» es del ${formatDay(toDay(a.balanceAt))} (hace ${age} días): lo que se movió después no está en la caja inicial.`,
      );
    }
  }

  // 2. CÓMO PAGA CADA CLIENTE ----------------------------------------------
  const learned: CounterpartyBehavior[] =
    input.behavior ?? behaviorFromHistory(movements, { asOf });
  const avg: CompanyBehavior = companyBehavior(movements, { asOf });
  const resolve = makeKeyResolver([
    ...movements.map((m) => ({ name: m.counterpartyName, taxId: m.counterpartyTaxId })),
    ...learned.map((b) => ({ name: b.counterpartyName, taxId: b.counterpartyTaxId })),
  ]);
  const behaviorByKey = new Map<string, CounterpartyBehavior>();
  for (const b of learned) {
    const k = resolve(b.counterpartyName, b.counterpartyTaxId);
    if (k && !behaviorByKey.has(k)) behaviorByKey.set(k, b);
  }

  // 3. LO QUE ESTÁ EN EL LIBRO, ABIERTO -------------------------------------
  const drafts: DraftItem[] = [];
  const cover: CoverRecord[] = [];
  let otherCurrencyMovements = 0;
  let noDueDate = 0;
  let spreadCount = 0;
  let receivableCount = 0;
  let payableCount = 0;
  const fewSampleClients = new Set<string>();
  const usedDefault = new Set<string>();
  const overdueByKey = new Map<string, { days: number; amount: number; probability: number }>();
  const stalePayables = { count: 0, amount: 0 };

  const sortedMovements = [...movements].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const m of sortedMovements) {
    if (m.status !== 'expected' || m.kind === 'transfer') continue;
    if (m.currency.trim().toUpperCase() !== currency) {
      otherCurrencyMovements++;
      continue;
    }
    const openAmount = Math.round(m.outstanding != null ? m.outstanding : m.amount);
    if (!(openAmount > 0)) continue;

    const isInvoice = m.kind === 'receivable' || m.kind === 'payable';
    let base: string;
    if (m.dueDate) base = toDay(m.dueDate);
    else if (isInvoice) {
      base = addDays(toDay(m.date), DEFAULT_TERMS_DAYS);
      noDueDate++;
    } else base = toDay(m.date);

    const key = resolve(m.counterpartyName, m.counterpartyTaxId);
    const common = {
      label: movementLabel(m),
      direction: m.direction,
      from: 'movement' as const,
      movementId: m.id,
      recurringId: null,
      counterpartyName: m.counterpartyName ?? null,
      counterpartyTaxId: m.counterpartyTaxId ?? null,
      category: m.category ?? null,
    };
    const overdueDays = daysBetween(base, asOf);
    const dueWord = overdueDays > 0 ? 'venció' : 'vence';
    let firstDate: string;

    if (m.kind === 'receivable' && m.direction === 'in') {
      receivableCount++;
      const known = key ? behaviorByKey.get(key) : undefined;
      const name = m.counterpartyName?.trim() ? shortName(m.counterpartyName) : 'este cliente';
      let delay: number;
      let rate: number;
      let who: string;
      if (known) {
        delay = Math.max(0, Math.round(known.typicalDelayDays));
        rate = clamp(known.collectionRate, 0, 1);
        const few = known.sample < FEW_SAMPLES;
        if (few) fewSampleClients.add(key as string);
        who = `${name} suele ${payPhrase(delay)} (${plural(known.sample, 'factura', 'facturas')}${few ? '; poca historia: se acercó al promedio de la empresa' : ''})`;
      } else if (avg.sample > 0) {
        delay = avg.typicalDelayDays;
        rate = avg.collectionRate;
        usedDefault.add(key ?? m.id);
        who = `sin historia de pagos de ${name}: se usó el cliente promedio de la empresa (suele ${payPhrase(delay)})`;
      } else {
        delay = 0;
        rate = DEFAULT_COLLECTION_RATE;
        usedDefault.add(key ?? m.id);
        who = 'sin historia de cobros: se asume que paga a tiempo';
      }

      if (overdueDays <= 0 || overdueDays < delay) {
        const date = addDays(base, delay);
        firstDate = date;
        const late = overdueDays > 0 ? ` (hace ${plural(overdueDays, 'día', 'días')})` : '';
        const tail = overdueDays > 0 ? `, así que se espera hacia el ${formatDay(date)}` : '';
        const prob = rate < 0.995 ? `; se cuenta el ${formatPct(rate)}` : '';
        drafts.push({
          ...common,
          amount: openAmount,
          probability: rate,
          expectedDate: date,
          reason: `${dueWord} el ${formatDay(base)}${late}; ${who}${tail}${prob}`,
        });
      } else {
        // Ya va más tarde de lo que este cliente suele demorarse: no se sabe
        // cuándo, así que se reparte, y cuanto más vieja, menos se cuenta.
        const excess = overdueDays - delay;
        const decay = 0.5 ** (excess / OVERDUE_HALF_LIFE_DAYS);
        const probability = Math.round(rate * decay * 1000) / 1000;
        const weeks = clamp(Math.round(excess / 30) + 2, 2, 6);
        spreadCount++;
        firstDate = asOf;
        const chunk = Math.floor(openAmount / weeks);
        for (let i = 0; i < weeks; i++) {
          const amount = i === weeks - 1 ? openAmount - chunk * (weeks - 1) : chunk;
          drafts.push({
            ...common,
            amount,
            probability,
            expectedDate: addDays(asOf, i * 7),
            reason: `venció el ${formatDay(base)} (hace ${plural(overdueDays, 'día', 'días')}); ${who}, y ya va más tarde que eso: se reparte en ${weeks} semanas (${i + 1} de ${weeks}) y se cuenta el ${formatPct(probability)}`,
          });
        }
        if (key) {
          const prev = overdueByKey.get(key);
          overdueByKey.set(key, {
            days: Math.max(prev?.days ?? 0, overdueDays),
            amount: (prev?.amount ?? 0) + openAmount,
            probability: Math.min(prev?.probability ?? 1, probability),
          });
        }
      }
    } else if (m.kind === 'payable' && m.direction === 'out') {
      payableCount++;
      firstDate = overdueDays > 0 ? asOf : base;
      if (overdueDays > STALE_PAYABLE_DAYS) {
        // Tanto tiempo vencida y sin un pago del banco que coincida: o ya se
        // pagó por otro lado, o se está negociando. Se pregunta y se cuenta a
        // medias, menos cuanto más vieja.
        const probability =
          Math.round(
            clamp(
              0.5 * 0.5 ** ((overdueDays - STALE_PAYABLE_DAYS) / STALE_PAYABLE_HALF_LIFE_DAYS),
              0.1,
              0.5,
            ) * 1000,
          ) / 1000;
        stalePayables.count++;
        stalePayables.amount += openAmount;
        drafts.push({
          ...common,
          amount: openAmount,
          probability,
          expectedDate: firstDate,
          reason: `¿ya la pagaste? lleva ${overdueDays} días vencida (venció el ${formatDay(base)}) y no aparece un pago del banco que coincida: se cuenta el ${formatPct(probability)}`,
        });
      } else {
        drafts.push({
          ...common,
          amount: openAmount,
          probability: 1,
          expectedDate: firstDate,
          reason:
            overdueDays > 0
              ? `venció el ${formatDay(base)} (hace ${plural(overdueDays, 'día', 'días')}) y sigue sin pagar: se cuenta esta semana`
              : `vence el ${formatDay(base)}; se asume que se paga ese día`,
        });
      }
    } else {
      firstDate = overdueDays > 0 ? asOf : base;
      drafts.push({
        ...common,
        amount: openAmount,
        probability: 1,
        expectedDate: firstDate,
        reason:
          overdueDays > 0
            ? `debía pasar el ${formatDay(base)} y no aparece liquidado: se cuenta esta semana`
            : `programado para el ${formatDay(base)}`,
      });
    }

    cover.push({
      direction: m.direction,
      key,
      category: categoryKey(m.category),
      signature: descriptionSignature(m.description),
      amount: openAmount,
      date: firstDate,
      used: false,
    });
  }

  // 4. LO QUE SE REPITE -----------------------------------------------------
  // Lo detectado del historial (menos lo que una persona ignoró) más lo
  // declarado; cuando hablan de lo mismo, manda lo declarado.
  const declared = input.recurring ?? [];
  const detectOn = input.detectRecurring !== false;
  const ignored = new Set(input.ignoredRecurring ?? []);
  const confirmed = new Set(input.confirmedRecurring ?? []);
  const detectedAll = detectOn ? detectRecurring(movements, asOf) : [];
  const detected = detectedAll.filter((f) => !(f.detectedKey && ignored.has(f.detectedKey)));
  const ignoredCount = detectedAll.length - detected.length;
  const allFlows = mergeRecurring(detected, declared);
  const flows = allFlows.filter((f) => f.currency.trim().toUpperCase() === currency);
  const settledRecent = sortedMovements
    .filter(
      (m) =>
        m.status === 'settled' &&
        m.kind !== 'transfer' &&
        m.currency.trim().toUpperCase() === currency &&
        daysBetween(toDay(m.settledAt ?? m.date), asOf) <= 45,
    )
    .map((m) => ({
      direction: m.direction,
      key: resolve(m.counterpartyName, m.counterpartyTaxId),
      category: categoryKey(m.category),
      signature: descriptionSignature(m.description),
      amount: m.amount,
      date: toDay(m.settledAt ?? m.date),
    }));
  let coveredCount = 0;
  let missedCount = 0;

  for (const flow of flows) {
    const flowKey = flow.counterpartyName ? resolve(flow.counterpartyName, null) : null;
    const window = COVER_WINDOW_DAYS[flow.every];
    const how =
      flow.every === 'month'
        ? `cada mes hacia el día ${flow.anchor}`
        : `cada ${weekdayName(flow.anchor)}`;
    const why =
      flow.origin === 'declared'
        ? `se declaró que pasa ${how}`
        : `se repite ${how} (${plural(flow.sample ?? 0, 'vez', 'veces')} en el historial${flow.detectedKey && confirmed.has(flow.detectedKey) ? ', y se confirmó' : ''}); monto: la mediana de las últimas`;
    const base = {
      label: flow.label,
      direction: flow.direction,
      amount: Math.round(flow.amount),
      probability: 1,
      from: 'recurring' as const,
      movementId: null,
      recurringId: flow.id,
      counterpartyName: flow.counterpartyName ?? null,
      counterpartyTaxId: null,
      category: flow.category ?? null,
    };

    const takeCover = (date: string): boolean => {
      let best: CoverRecord | null = null;
      for (const rec of cover) {
        if (rec.used || !flowMatches(flow, flowKey, rec)) continue;
        const gap = Math.abs(daysBetween(rec.date, date));
        if (gap > window) continue;
        if (!best || gap < Math.abs(daysBetween(best.date, date))) best = rec;
      }
      if (!best) return false;
      best.used = true;
      return true;
    };

    // Un gasto fijo que debía pasar hace pocos días y no aparece pagado.
    // Sólo para lo detectado: su historial prueba el patrón, así que la
    // ausencia dice algo. Uno declarado puede estar empezando.
    if (flow.direction === 'out' && flow.every === 'month' && flow.origin === 'detected') {
      const thisMonth = dayOfMonth(Number(asOf.slice(0, 4)), Number(asOf.slice(5, 7)), flow.anchor);
      const prevIdx = monthIndex(asOf) - 1;
      const prev =
        thisMonth < asOf
          ? thisMonth
          : dayOfMonth(Math.floor(prevIdx / 12), (prevIdx % 12) + 1, flow.anchor);
      const ago = daysBetween(prev, asOf);
      if (ago >= 1 && ago <= MISSED_RECURRING_GRACE_DAYS) {
        const seen = settledRecent.some(
          (s) => flowMatches(flow, flowKey, s) && Math.abs(daysBetween(s.date, prev)) <= window,
        );
        if (!seen && !takeCover(prev)) {
          missedCount++;
          drafts.push({
            ...base,
            expectedDate: asOf,
            reason: `${why}; debía pasar el ${formatDay(prev)} y todavía no aparece pagado: se cuenta esta semana`,
          });
        }
      }
    }

    const dates =
      flow.every === 'month'
        ? monthlyDates(flow.anchor, asOf, horizonEnd)
        : weeklyDates(flow.anchor, asOf, horizonEnd);
    for (const date of dates) {
      if (takeCover(date)) {
        coveredCount++;
        continue;
      }
      drafts.push({ ...base, expectedDate: date, reason: why });
    }
  }

  // 4b. VENTAS QUE TODAVÍA NO SE HAN FACTURADO -------------------------------
  const includeEstimates = input.includeEstimatedSales !== false;
  let estimatedClients = 0;
  if (includeEstimates) {
    const inflowKeys = new Set(
      flows
        .filter((f) => f.direction === 'in' && f.counterpartyName)
        .map((f) => resolve(f.counterpartyName, null))
        .filter((k): k is string => Boolean(k)),
    );
    const est = estimateSales({
      movements: sortedMovements,
      asOf,
      horizonEnd,
      currency,
      resolve,
      behaviorByKey,
      avg,
      skipKeys: inflowKeys,
    });
    drafts.push(...est.items);
    estimatedClients = est.clients;
  }

  // 5. EL ESCENARIO ---------------------------------------------------------
  const scenario = input.scenario ?? null;
  const applied = applyScenario(drafts, scenario, { asOf, horizonEnd, currency });

  // 6. A SU SEMANA ----------------------------------------------------------
  const beyond = new Set<string>();
  const inHorizon: ForecastItem[] = [];
  for (const d of applied.items) {
    if (d.expectedDate > horizonEnd) {
      if (d.movementId) beyond.add(d.movementId);
      continue;
    }
    const probability = Math.round(clamp(d.probability, 0, 1) * 1000) / 1000;
    const amount = Math.round(d.amount);
    inHorizon.push({
      label: d.label,
      direction: d.direction,
      amount,
      expectedAmount: Math.round(amount * probability),
      probability,
      expectedDate: d.expectedDate < asOf ? asOf : d.expectedDate,
      movementId: d.movementId ?? null,
      recurringId: d.recurringId ?? null,
      reason: d.reason,
      counterpartyName: d.counterpartyName ?? null,
      category: d.category ?? null,
      from: d.from,
    });
  }
  inHorizon.sort(
    (a, b) =>
      (a.expectedDate < b.expectedDate ? -1 : a.expectedDate > b.expectedDate ? 1 : 0) ||
      (a.direction === b.direction ? 0 : a.direction === 'in' ? -1 : 1) ||
      b.expectedAmount - a.expectedAmount ||
      (a.label < b.label ? -1 : a.label > b.label ? 1 : 0) ||
      ((a.movementId ?? a.recurringId ?? '') < (b.movementId ?? b.recurringId ?? '') ? -1 : 1),
  );

  const weeks: ForecastWeek[] = [];
  let running = startingCash;
  for (let i = 0; i < horizonWeeks; i++) {
    const start = addDays(firstMonday, i * 7);
    const end = addDays(start, 6);
    const items = inHorizon.filter((it) => it.expectedDate >= start && it.expectedDate <= end);
    const inflows = items
      .filter((it) => it.direction === 'in')
      .reduce((s, it) => s + it.expectedAmount, 0);
    const outflows = items
      .filter((it) => it.direction === 'out')
      .reduce((s, it) => s + it.expectedAmount, 0);
    const opening = running;
    running = opening + inflows - outflows;
    weeks.push({ start, opening, inflows, outflows, closing: running, items });
  }
  let lowestWeek = weeks[0] as ForecastWeek;
  for (const w of weeks) if (w.closing < lowestWeek.closing) lowestWeek = w;
  const lowest = { week: lowestWeek.start, closing: lowestWeek.closing };

  // 7. CAJA MÍNIMA ----------------------------------------------------------
  const monthlyRecurringOut = Math.round(
    flows
      .filter((f) => f.direction === 'out')
      .reduce((s, f) => s + (f.every === 'month' ? f.amount : (f.amount * 52) / 12), 0),
  );
  const minimumGiven = input.minimumCash != null;
  const minimum = minimumGiven ? Math.round(input.minimumCash as number) : monthlyRecurringOut;

  // 8. ALERTAS --------------------------------------------------------------
  const alerts: ForecastAlert[] = [];
  const minimumWhy = minimumGiven ? 'el mínimo fijado' : 'un mes de gastos fijos';
  const firstNegative = weeks.find((w) => w.closing < 0);
  if (firstNegative) {
    const tail =
      firstNegative.start === lowest.week
        ? ''
        : `; lo más bajo es ${fm(lowest.closing)} la semana del ${formatDay(lowest.week)}`;
    alerts.push({
      kind: 'negative_cash',
      week: firstNegative.start,
      severity: 'critical',
      message: `La caja queda en rojo la semana del ${formatDay(firstNegative.start)} (${fm(firstNegative.closing)})${tail}.`,
    });
  } else if (minimum > 0 && lowest.closing < minimum) {
    alerts.push({
      kind: 'low_cash',
      week: lowest.week,
      severity: 'warn',
      message: `La caja baja a ${fm(lowest.closing)} la semana del ${formatDay(lowest.week)}, por debajo de ${fm(minimum)} (${minimumWhy}).`,
    });
  }

  const inflowItems = inHorizon.filter((it) => it.direction === 'in');
  const totalIn = inflowItems.reduce((s, it) => s + it.expectedAmount, 0);
  if (totalIn > 0) {
    const byClient = new Map<string, { name: string; amount: number }>();
    for (const it of inflowItems) {
      if (!it.counterpartyName) continue;
      const k = resolve(it.counterpartyName, null) ?? it.counterpartyName;
      const prev = byClient.get(k);
      byClient.set(k, {
        name: prev?.name ?? it.counterpartyName,
        amount: (prev?.amount ?? 0) + it.expectedAmount,
      });
    }
    const ranked = [...byClient.values()].sort(
      (a, b) => b.amount - a.amount || (a.name < b.name ? -1 : 1),
    );
    for (const c of ranked) {
      const share = c.amount / totalIn;
      if (share <= CONCENTRATION_SHARE) break;
      alerts.push({
        kind: 'concentration',
        week: null,
        severity: 'warn',
        counterpartyName: c.name,
        message: `${shortName(c.name)} es el ${formatPct(share)} de lo que se espera cobrar en ${horizonWeeks} semanas (${fm(c.amount)} de ${fm(totalIn)}): si se atrasa, se siente.`,
      });
    }
  }

  const lateByKey = new Map<string, { name: string; open: number }>();
  for (const it of inflowItems) {
    if (it.from !== 'movement' || !it.counterpartyName) continue;
    const k = resolve(it.counterpartyName, null);
    if (!k) continue;
    const prev = lateByKey.get(k);
    lateByKey.set(k, { name: it.counterpartyName, open: (prev?.open ?? 0) + it.amount });
  }
  for (const [k, info] of [...lateByKey.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const b = behaviorByKey.get(k);
    const overdue = overdueByKey.get(k);
    const slow =
      b &&
      b.sample >= 2 &&
      (b.typicalDelayDays >= LATE_PAYER_DAYS || b.collectionRate < LATE_PAYER_RATE);
    const stale = overdue && overdue.days > 60;
    if (!slow && !stale) continue;
    const name = shortName(b?.counterpartyName || info.name);
    const parts: string[] = [];
    if (slow && b) {
      parts.push(
        `${name} suele ${payPhrase(b.typicalDelayDays)} y termina pagando el ${formatPct(b.collectionRate)} (${plural(b.sample, 'factura', 'facturas')})`,
      );
    }
    if (stale && overdue) {
      parts.push(
        `${slow ? 'tiene' : `${name} tiene`} ${fm(overdue.amount)} vencidos hace ${overdue.days} días que se cuentan al ${formatPct(overdue.probability)}`,
      );
    }
    alerts.push({
      kind: 'late_payer',
      week: null,
      severity: 'warn',
      counterpartyName: b?.counterpartyName || info.name,
      message: `${parts.join('; ')}. La proyección ya lo cuenta así; cobrarle a tiempo mejora la caja.`,
    });
  }

  const bigThreshold = Math.max(monthlyRecurringOut, Math.round(startingCash * 0.25));
  if (bigThreshold > 0) {
    const big = inHorizon
      .filter(
        (it) =>
          it.direction === 'out' && it.from !== 'recurring' && it.expectedAmount >= bigThreshold,
      )
      .sort(
        (a, b) => b.expectedAmount - a.expectedAmount || (a.expectedDate < b.expectedDate ? -1 : 1),
      )
      .slice(0, 3);
    for (const it of big) {
      const week = mondayOf(it.expectedDate);
      const w = weeks.find((x) => x.start === week);
      const tight = w ? w.closing < Math.max(minimum, 0) || w.closing < 0 : false;
      alerts.push({
        kind: 'big_outflow',
        week,
        severity: tight ? 'warn' : 'info',
        message: `Pago grande: ${it.label}, ${fm(it.expectedAmount)} el ${formatDay(it.expectedDate)}${tight ? ', en una semana que ya queda apretada' : ''}.`,
      });
    }
  }

  alerts.sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      (a.week ?? '9999').localeCompare(b.week ?? '9999') ||
      a.kind.localeCompare(b.kind) ||
      a.message.localeCompare(b.message),
  );

  // 9. SUPUESTOS ------------------------------------------------------------
  if (receivableCount > 0) {
    assumptions.push(
      'Lo por cobrar entra en su vencimiento más el atraso típico de cada cliente, y se cuenta por la fracción que ese cliente suele pagar.',
    );
    if (usedDefault.size > 0) {
      assumptions.push(
        avg.sample > 0
          ? `Para ${plural(usedDefault.size, 'cliente', 'clientes')} sin historia se usó el cliente promedio de la empresa: paga ${avg.typicalDelayDays} días tarde y se le cobra el ${formatPct(avg.collectionRate)} (${plural(avg.sample, 'factura', 'facturas')}).`
          : `No hay historia de cobros: se asume que los clientes pagan a tiempo y se cuenta el ${formatPct(DEFAULT_COLLECTION_RATE)}.`,
      );
    }
    if (fewSampleClients.size > 0) {
      assumptions.push(
        `${plural(fewSampleClients.size, 'cliente tiene', 'clientes tienen')} menos de ${FEW_SAMPLES} facturas: su comportamiento se acercó al promedio de la empresa.`,
      );
    }
  }
  if (spreadCount > 0) {
    assumptions.push(
      `Lo vencido más allá de lo que el cliente suele demorarse se reparte en las próximas semanas y pierde probabilidad: ${OVERDUE_HALF_LIFE_DAYS} días después cuenta la mitad.`,
    );
  }
  if (payableCount > 0) {
    assumptions.push(
      'Las facturas por pagar se pagan el día que vencen; las vencidas, esta semana.',
    );
  }
  if (stalePayables.count > 0) {
    assumptions.push(
      `${plural(stalePayables.count, 'factura por pagar lleva', 'facturas por pagar llevan')} más de ${STALE_PAYABLE_DAYS} días ${stalePayables.count === 1 ? 'vencida' : 'vencidas'} sin un pago del banco que coincida (${fm(stalePayables.amount)}): puede que ya se haya pagado por otro lado, así que se cuenta a medias y menos cuanto más vieja. Si ya se pagó, dilo o importa el extracto.`,
    );
  }
  if (noDueDate > 0) {
    assumptions.push(
      `${plural(noDueDate, 'factura no trae', 'facturas no traen')} vencimiento: se asumió ${DEFAULT_TERMS_DAYS} días desde la emisión.`,
    );
  }
  if (flows.length > 0) {
    const outN = flows.filter((f) => f.direction === 'out').length;
    const inN = flows.length - outN;
    const what = joinCounts(outN, inN);
    const declaredN = flows.filter((f) => f.origin === 'declared').length;
    const detectedN = flows.length - declaredN;
    assumptions.push(
      declaredN === 0
        ? `Se proyectan ${what} que se repiten, detectados del historial (3 veces o más, a intervalos regulares), con la mediana de sus últimos montos.`
        : detectedN === 0
          ? `Se proyectan ${what} que se repiten, según lo declarado, con su monto fijo.`
          : `Se proyectan ${what} que se repiten: ${detectedN} ${detectedN === 1 ? 'detectado' : 'detectados'} del historial (con la mediana de sus últimos montos) y ${declaredN} ${declaredN === 1 ? 'declarado' : 'declarados'} (con su monto fijo; lo declarado manda cuando habla de lo mismo).`,
    );
  } else {
    assumptions.push(
      !detectOn
        ? 'No se proyectan gastos que se repitan: la lista recibida está vacía.'
        : 'No se detectaron gastos que se repitan (hace falta verlos 3 veces o más a intervalos regulares): la tabla puede quedarse corta en salidas.',
    );
  }
  if (ignoredCount > 0) {
    assumptions.push(
      `${plural(ignoredCount, 'recurrente detectado quedó', 'recurrentes detectados quedaron')} por fuera porque una persona dijo que no se repite.`,
    );
  }
  if (coveredCount > 0) {
    assumptions.push(
      `${plural(coveredCount, 'ocurrencia', 'ocurrencias')} de lo que se repite ya ${coveredCount === 1 ? 'está' : 'están'} como factura en el libro: no se cuenta dos veces.`,
    );
  }
  if (missedCount > 0) {
    assumptions.push(
      `${plural(missedCount, 'gasto fijo debía', 'gastos fijos debían')} pasar en los últimos días y no ${missedCount === 1 ? 'aparece' : 'aparecen'} pagados: se cuentan esta semana.`,
    );
  }
  if (!includeEstimates) {
    assumptions.push(
      'No se proyectan ventas que todavía no se han facturado, salvo ingresos que se repiten.',
    );
  } else if (estimatedClients > 0) {
    assumptions.push(
      `Se estiman las ventas que todavía no se han facturado a ${plural(estimatedClients, 'cliente que factura', 'clientes que facturan')} casi todos los meses (${ESTIMATE_MIN_MONTHS} o más de los últimos ${ESTIMATE_WINDOW_MONTHS}): su promedio mensual de esos ${ESTIMATE_WINDOW_MONTHS} meses, cobrado con su plazo y su atraso típico, y contado al ${formatPct(ESTIMATE_PROBABILITY_FACTOR)} de lo que suelen pagar. Son estimaciones («Ventas estimadas a …»), no facturas; lo demás sin facturar no entra.`,
    );
  } else {
    assumptions.push(
      `Ningún cliente factura casi todos los meses (${ESTIMATE_MIN_MONTHS} o más de los últimos ${ESTIMATE_WINDOW_MONTHS}): no se estiman ventas sin facturar; sólo entra lo facturado y los ingresos que se repiten.`,
    );
  }
  if (minimum > 0) {
    assumptions.push(
      minimumGiven
        ? `Caja mínima: ${fm(minimum)} (la que se fijó).`
        : `Caja mínima: ${fm(minimum)}, un mes de los gastos que se repiten.`,
    );
  } else {
    assumptions.push('Sin caja mínima: sólo se avisa si la caja queda en rojo.');
  }
  if (otherCurrencyMovements > 0) {
    assumptions.push(
      `${plural(otherCurrencyMovements, 'movimiento abierto', 'movimientos abiertos')} en otra moneda ${otherCurrencyMovements === 1 ? 'quedó' : 'quedaron'} por fuera.`,
    );
  }
  const excludedFlows = allFlows.length - flows.length;
  if (excludedFlows > 0) {
    assumptions.push(
      `${plural(excludedFlows, 'gasto recurrente', 'gastos recurrentes')} en otra moneda ${excludedFlows === 1 ? 'quedó' : 'quedaron'} por fuera.`,
    );
  }
  if (beyond.size > 0) {
    assumptions.push(
      `${plural(beyond.size, 'cobro o pago cae', 'cobros o pagos caen')} después del ${formatDay(horizonEnd)} y no ${beyond.size === 1 ? 'entra' : 'entran'} en estas ${horizonWeeks} semanas.`,
    );
  }
  if (scenario) {
    assumptions.push(describeScenario(scenario, currency));
    assumptions.push(...applied.notes);
  }

  return {
    asOf,
    currency,
    startingCash,
    weeks,
    lowest,
    alerts,
    assumptions,
    scenario,
    minimumCash: minimum,
    accountCount: sameCurrency.length,
  };
}

function joinCounts(outN: number, inN: number): string {
  if (outN && inN)
    return `${plural(outN, 'gasto', 'gastos')} y ${plural(inN, 'ingreso', 'ingresos')}`;
  if (outN) return plural(outN, 'gasto', 'gastos');
  return plural(inN, 'ingreso', 'ingresos');
}

// ---------------------------------------------------------------------------
// Ventas estimadas
// ---------------------------------------------------------------------------

interface EstimateContext {
  movements: readonly LedgerMovement[];
  asOf: string;
  horizonEnd: string;
  currency: string;
  resolve: (name?: string | null, taxId?: string | null) => string | null;
  behaviorByKey: ReadonlyMap<string, CounterpartyBehavior>;
  avg: CompanyBehavior;
  /** Clientes que ya entran como ingreso que se repite: no se cuentan dos veces. */
  skipKeys: ReadonlySet<string>;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/**
 * Lo que un cliente regular todavía no ha facturado, al ritmo de sus últimos
 * seis meses. Sólo clientes con factura (o ingreso de venta, si no factura en
 * el libro) en 3 o más de esos meses; el ritmo es el promedio de los seis
 * (los meses sin factura cuentan como cero: prudente). Mes por mes en el
 * horizonte, lo que falta facturar se pone el día que suele facturar y se
 * cobra con su plazo y su atraso típicos.
 */
function estimateSales(ctx: EstimateContext): { items: DraftItem[]; clients: number } {
  const fm = (n: number) => formatMoney(n, ctx.currency);
  const current = monthIndex(ctx.asOf);
  const first = current - ESTIMATE_WINDOW_MONTHS;
  interface Sale {
    month: number;
    day: string;
    amount: number;
    terms: number | null;
    invoice: boolean;
  }
  const byKey = new Map<string, { name: string; taxId: string | null; sales: Sale[] }>();
  for (const m of ctx.movements) {
    if (m.direction !== 'in' || m.status === 'cancelled') continue;
    if (m.currency.trim().toUpperCase() !== ctx.currency) continue;
    const invoice = m.kind === 'receivable';
    const cashSale =
      m.kind === 'income' &&
      m.status === 'settled' &&
      (!m.category || categoryKey(m.category) === 'ventas');
    if (!invoice && !cashSale) continue;
    const key = ctx.resolve(m.counterpartyName, m.counterpartyTaxId);
    if (!key || ctx.skipKeys.has(key)) continue;
    const day = toDay(m.date);
    const month = monthIndex(day);
    if (month < first || month > current) continue;
    const entry = byKey.get(key) ?? {
      name: (m.counterpartyName ?? '').trim() || (m.counterpartyTaxId ?? '').trim(),
      taxId: m.counterpartyTaxId ?? null,
      sales: [],
    };
    if (!entry.taxId && m.counterpartyTaxId) entry.taxId = m.counterpartyTaxId;
    entry.sales.push({
      month,
      day,
      amount: m.amount,
      terms: invoice && m.dueDate ? Math.max(0, daysBetween(day, toDay(m.dueDate))) : null,
      invoice,
    });
    byKey.set(key, entry);
  }

  const items: DraftItem[] = [];
  let clients = 0;
  for (const [key, entry] of [...byKey.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    // Si factura en el libro, cuentan sus facturas; si no, sus ingresos de
    // venta. Las dos juntas contarían dos veces la misma venta.
    const invoices = entry.sales.some((s) => s.invoice);
    const sales = entry.sales.filter((s) => s.invoice === invoices);
    const past = sales.filter((s) => s.month < current);
    const months = new Set(past.map((s) => s.month));
    if (months.size < ESTIMATE_MIN_MONTHS) continue;
    const runRate = Math.round(past.reduce((sum, s) => sum + s.amount, 0) / ESTIMATE_WINDOW_MONTHS);
    if (!(runRate > 0)) continue;
    const anchor = Math.round(median(past.map((s) => Number(s.day.slice(8, 10)))));
    const termsSeen = past.flatMap((s) => (s.terms === null ? [] : [s.terms]));
    const terms = invoices
      ? termsSeen.length
        ? Math.round(median(termsSeen))
        : DEFAULT_TERMS_DAYS
      : 0;
    const known = ctx.behaviorByKey.get(key);
    const delay = invoices
      ? Math.max(0, Math.round(known?.typicalDelayDays ?? ctx.avg.typicalDelayDays))
      : 0;
    const rate = invoices
      ? clamp(
          known?.collectionRate ??
            (ctx.avg.sample > 0 ? ctx.avg.collectionRate : DEFAULT_COLLECTION_RATE),
          0,
          1,
        )
      : DEFAULT_COLLECTION_RATE;
    const probability = Math.round(rate * ESTIMATE_PROBABILITY_FACTOR * 1000) / 1000;
    const name = shortName(entry.name);
    let any = false;
    for (let mi = current; mi <= monthIndex(ctx.horizonEnd); mi++) {
      const already = sales.filter((s) => s.month === mi).reduce((sum, s) => sum + s.amount, 0);
      const remaining = runRate - already;
      if (remaining < runRate * 0.1) continue;
      let issue = dayOfMonth(Math.floor(mi / 12), (mi % 12) + 1, anchor);
      if (issue < ctx.asOf) issue = ctx.asOf;
      const collect = addDays(issue, terms + delay);
      if (collect > ctx.horizonEnd) continue;
      any = true;
      const how = invoices
        ? `se estima facturado hacia el ${formatDay(issue)} y cobrado hacia el ${formatDay(collect)} (plazo de ${plural(terms, 'día', 'días')}${delay > 0 ? `; suele pagar ${plural(delay, 'día', 'días')} tarde` : ''})`
        : `se estima que entra hacia el ${formatDay(collect)}`;
      items.push({
        label: `Ventas estimadas a ${name}`,
        direction: 'in',
        amount: Math.round(remaining),
        probability,
        expectedDate: collect,
        reason: `${name} ${invoices ? 'factura' : 'compra'} casi todos los meses (${months.size} de los últimos ${ESTIMATE_WINDOW_MONTHS}; promedio ${fm(runRate)} al mes)${already > 0 ? `; este mes ya van ${fm(already)}` : ''}; lo que falta ${how}. Es una estimación, no una factura: se cuenta el ${formatPct(probability)}`,
        from: 'estimate',
        movementId: null,
        recurringId: `est-${stableHash(`${key}|${mi}`)}`,
        counterpartyName: entry.name || null,
        counterpartyTaxId: entry.taxId,
        category: 'ventas',
      });
    }
    if (any) clients++;
  }
  return { items, clients };
}
