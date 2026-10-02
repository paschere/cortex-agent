/**
 * CÓMO VA CADA NEGOCIO, Y DÓNDE ACTUAR HOY. Puro, sin base de datos.
 *
 * ===========================================================================
 * POR QUÉ EXISTE
 * ===========================================================================
 * La consola del fundador nació como administración de SaaS: plan, asientos,
 * cupo de respuestas, integraciones. Eso le importa a quien paga Cortex una vez
 * al mes. A quien dirige cinco empresas le importa otra cosa cada mañana:
 * cuánta plata está en riesgo en cada una, cuánta volvió, qué procesos se
 * cayeron, qué decisiones lo esperan — y a cuál entrar primero.
 *
 * Aquí viven las reglas de esa lectura —el estado en palabras («Al día»,
 * «Pide atención», «Sin datos todavía»), la lista «Dónde actuar hoy» y los
 * totales— separadas de las consultas (founder-business.ts) para probarlas
 * sin Postgres (founder-business-shape.test.ts) y para que el componente de
 * cliente las use tal cual.
 *
 * ===========================================================================
 * «SIN DATO» NO ES CERO
 * ===========================================================================
 * Cada cifra de `CompanyBusiness` es `null` cuando no se pudo leer (la tabla no
 * respondió, la lectura tardó demasiado, la empresa no tiene pulso). Un `null`
 * nunca se suma como cero ni se pinta como «$ 0»: los totales dicen de cuántas
 * empresas falta el dato, y la tarjeta dice «sin dato».
 *
 * NO SE MEZCLAN MONEDAS. Las cifras principales son en pesos; lo que esté en
 * otra moneda va aparte, con su código, igual que en payments/risk.ts.
 */

import type { ConsoleRow } from './founder-console-shape';
import { workspaceHref } from './workspace-context';

/** Lo que el centro de mando sabe del negocio de UNA empresa propia. */
export interface CompanyBusiness {
  organizationId: string;
  /** Plata en riesgo (payments/risk.ts). `null`: sin dato. */
  risk: {
    /** Pesos: cartera vencida + pagos vencidos o de esta semana + multas. */
    total: number;
    receivablesOverdue: number;
    overdueInvoices: number;
    paymentsOverdue: number;
    paymentsDueSoon: number;
    finesPending: number;
    /** Cartera vencida en otras monedas, cada una por su lado. */
    others: Array<{ currency: string; amount: number; invoices: number }>;
  } | null;
  /** Recuperado con Cortex (payments/recovered.ts). `null`: sin dato. */
  recovered: {
    /** Pesos recuperados este mes (Bogotá). */
    month: number;
    monthInvoices: number;
    total: number;
    others: Array<{ currency: string; month: number }>;
  } | null;
  /**
   * Ventas del mes según la última foto del pulso (pulse_snapshots). `null`
   * cuando la empresa no tiene pulso, la foto es de otro mes o no trae ventas.
   * `previous` es el mes anterior COMPLETO: no se compara en porcentaje contra
   * un mes a medias.
   */
  sales: { month: number; previous: number | null; asOf: string } | null;
  /**
   * La caja de hoy y cuánto alcanza, de la proyección del libro de plata
   * (ledger/plans.ts, la misma de /finance). En pesos. `null`: sin dato — la
   * lectura falló o la empresa no tiene saldos ni movimientos (ver `ledger`).
   */
  cash: {
    /** Caja de hoy: la suma de los saldos de sus cuentas. */
    today: number;
    /**
     * Semanas enteras antes de que el cierre proyectado baje del mínimo de caja
     * (o de cero si no hay mínimo). `null`: no baja en todo el horizonte («13+»).
     */
    runwayWeeks: number | null;
    /** Semanas que mira la proyección; «13+» sale de aquí. */
    horizonWeeks: number;
    /** La semana con el cierre más bajo. */
    lowest: { week: string; closing: number };
  } | null;
  /** Si la empresa tiene algo en el libro de plata (cuentas o movimientos). `null`: sin dato. */
  ledger: boolean | null;
  /** Rutinas cuya última corrida falló + sincronizaciones en error. `null`: sin dato. */
  failing: { routines: number; syncs: number; total: number } | null;
  /** Puesta en marcha (self-service/setup.ts). `null`: sin dato. */
  setup: { ready: number; total: number; percent: number; next: string | null } | null;
  /** Cuándo llegó la decisión más vieja que sigue esperando a quien mira. */
  oldestDecisionAt: string | null;
  /** Si la empresa tiene la vista «Pulso de la empresa». `null`: sin dato. */
  pulseView: boolean | null;
  /** Marca de la empresa (company_branding). `null`: sin marca o sin dato. */
  brand: { name: string | null; color: string | null; logoUrl: string | null } | null;
}

export type BusinessMap = Readonly<Record<string, CompanyBusiness>>;

/* ------------------------------------------------------------------------- */
/* Cifras en palabras                                                        */
/* ------------------------------------------------------------------------- */

const ONE_DECIMAL = new Intl.NumberFormat('es-CO', { maximumFractionDigits: 1 });
const WHOLE = new Intl.NumberFormat('es-CO', { maximumFractionDigits: 0 });

/** «$ 38,5 M», «$ 950 mil», «$ 1,2 mil M»: pesos para leer de un vistazo. */
export function compactCop(value: number): string {
  const sign = value < 0 ? '−' : '';
  const n = Math.abs(value);
  if (n >= 1e9) return `${sign}$ ${ONE_DECIMAL.format(n / 1e9)} mil M`;
  if (n >= 1e6) return `${sign}$ ${ONE_DECIMAL.format(n / 1e6)} M`;
  if (n >= 1e3) return `${sign}$ ${WHOLE.format(n / 1e3)} mil`;
  return `${sign}$ ${WHOLE.format(n)}`;
}

/** «$ 38.512.000»: la cifra exacta, para el título o la ficha. */
export function fullCop(value: number): string {
  return `$ ${WHOLE.format(value)}`;
}

/** «12.000 USD». Otra moneda nunca se escribe con el signo del peso. */
export function otherCurrency(amount: number, currency: string): string {
  return `${ONE_DECIMAL.format(amount)} ${currency}`;
}

/** Días enteros entre un instante y ahora, nunca negativos. */
export function daysSince(iso: string | null, now: Date): number | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return null;
  return Math.max(0, Math.floor((now.getTime() - at) / 86_400_000));
}

function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString('es-CO')} ${n === 1 ? one : many}`;
}

function waitedPhrase(days: number): string {
  if (days <= 0) return 'desde hoy';
  if (days === 1) return 'desde ayer';
  return `hace ${days} días`;
}

/* ------------------------------------------------------------------------- */
/* El estado en palabras                                                     */
/* ------------------------------------------------------------------------- */

export type BusinessTone = 'emerald' | 'amber' | 'rose' | 'neutral';

export interface CompanyStatus {
  tone: BusinessTone;
  label: 'Al día' | 'Pide atención' | 'Sin datos todavía' | 'Sin lectura';
  /** Por qué, en frases cortas; vacío cuando está al día. */
  reasons: string[];
}

/** Una decisión que lleva este tiempo esperando ya es un atasco, no un pendiente. */
export const STALE_DECISION_DAYS = 2;
/** Por debajo de esto, una empresa sin cifras está empezando, no «al día». */
export const SETUP_STARTING_PERCENT = 60;
/** Caja para estas semanas o menos ya pide atención. */
export const CASH_TIGHT_WEEKS = 2;

/** «13+», «5», «0»: las semanas que alcanza la caja, en el horizonte de la proyección. */
export function cashWeeksLabel(cash: NonNullable<CompanyBusiness['cash']>): string {
  return cash.runwayWeeks === null ? `${cash.horizonWeeks}+` : String(cash.runwayWeeks);
}

/** Si la caja ya está apretada: baja del mínimo en `CASH_TIGHT_WEEKS` semanas o menos. */
export function cashIsTight(cash: CompanyBusiness['cash']): boolean {
  return cash !== null && cash.runwayWeeks !== null && cash.runwayWeeks <= CASH_TIGHT_WEEKS;
}

function cashReason(weeks: number): string {
  return weeks <= 0
    ? 'La caja no alcanza esta semana'
    : `Caja para ${plural(weeks, 'semana', 'semanas')}`;
}

/** Sólo lo que la regla necesita de una fila; así se prueba sin armar una entera. */
export type StatusRow = Pick<ConsoleRow, 'kind' | 'owned' | 'pulse'> & {
  health: Pick<
    NonNullable<ConsoleRow['health']>,
    'status' | 'subscriptionStatus' | 'answers'
  > | null;
};

function hasBusinessData(b: CompanyBusiness): boolean {
  return (
    (b.risk !== null && (b.risk.total > 0 || b.risk.others.length > 0)) ||
    (b.recovered !== null && b.recovered.total > 0) ||
    (b.sales !== null && b.sales.month > 0) ||
    b.cash !== null
  );
}

function allUnknown(b: CompanyBusiness): boolean {
  return (
    b.risk === null &&
    b.recovered === null &&
    b.failing === null &&
    b.setup === null &&
    b.cash === null
  );
}

/**
 * El estado de una empresa en palabras que no necesitan explicación.
 *
 * `business` es `undefined` mientras llega (o en empresas ajenas, que nunca lo
 * traen): entonces se decide sólo con los pendientes, que sí son de quien mira.
 */
export function companyStatus(
  row: StatusRow,
  business: CompanyBusiness | null | undefined,
  now: Date = new Date(),
): CompanyStatus {
  const reasons: string[] = [];
  let rose = false;

  if (
    row.health?.subscriptionStatus === 'past_due' ||
    row.health?.subscriptionStatus === 'canceled'
  ) {
    reasons.push('El pago del plan está pendiente');
    rose = true;
  }
  if (row.health?.answers?.state === 'blocked') {
    reasons.push('Se acabaron las respuestas del mes');
    rose = true;
  }

  if (business) {
    const risk = business.risk;
    if (risk && risk.receivablesOverdue > 0)
      reasons.push(`${compactCop(risk.receivablesOverdue)} en cartera vencida`);
    if (risk && risk.paymentsOverdue > 0)
      reasons.push(`${compactCop(risk.paymentsOverdue)} en pagos vencidos`);
    for (const other of risk?.others ?? [])
      if (other.amount > 0)
        reasons.push(`${otherCurrency(other.amount, other.currency)} en cartera vencida`);
    const runway = business.cash?.runwayWeeks ?? null;
    if (runway !== null && runway <= CASH_TIGHT_WEEKS) reasons.push(cashReason(runway));
    if (business.failing && business.failing.total > 0)
      reasons.push(plural(business.failing.total, 'proceso con error', 'procesos con error'));
  }

  if (row.pulse.status === 'ready') {
    if ((row.pulse.blocked ?? 0) > 0)
      reasons.push(plural(row.pulse.blocked ?? 0, 'asunto bloqueado', 'asuntos bloqueados'));
    const decisions = row.pulse.approvals + row.pulse.actions;
    const waited = daysSince(business?.oldestDecisionAt ?? null, now);
    if (decisions > 0 && waited !== null && waited >= STALE_DECISION_DAYS)
      reasons.push(
        `${plural(decisions, 'decisión espera', 'decisiones esperan')} ${waitedPhrase(waited)}`,
      );
  }

  if (reasons.length > 0) return { tone: rose ? 'rose' : 'amber', label: 'Pide atención', reasons };

  if (row.pulse.status === 'unavailable' && (!business || allUnknown(business)))
    return { tone: 'neutral', label: 'Sin lectura', reasons: ['Cortex no pudo leer esta empresa'] };

  if (business && !hasBusinessData(business)) {
    const percent = business.setup?.percent ?? null;
    if (percent === null || percent < SETUP_STARTING_PERCENT)
      return {
        tone: 'neutral',
        label: 'Sin datos todavía',
        reasons: percent === null ? [] : [`Puesta en marcha al ${percent} %`],
      };
  }

  return { tone: 'emerald', label: 'Al día', reasons: [] };
}

/* ------------------------------------------------------------------------- */
/* Dónde actuar hoy                                                          */
/* ------------------------------------------------------------------------- */

export type ActionKind =
  | 'billing'
  | 'receivables'
  | 'payments'
  | 'failing'
  | 'decisions'
  | 'blocked'
  | 'deadlines'
  | 'setup'
  | 'unreadable';

export interface ActionItem {
  /** Estable: empresa + clase. */
  id: string;
  kind: ActionKind;
  companyId: string;
  companyName: string;
  /** Lo que pasa, sin el nombre de la empresa: «$ 38,5 M vencidos, 7 facturas». */
  text: string;
  /** El botón: «Cobrar», «Revisar»… */
  cta: string;
  /** La pantalla dentro de la empresa: «/payments». */
  path: string;
  /** La misma con `?workspace=`: abre ESA empresa sin cambiar la de las demás pestañas. */
  href: string;
  tone: 'rose' | 'amber' | 'primary' | 'neutral';
  score: number;
}

/**
 * Plata: 60 a 90 puntos según el orden de magnitud, de $ 100 mil a $ 100 M.
 * Una deuda de $ 50 M pesa más que una de $ 500 mil, pero ninguna cifra tapa
 * por sí sola un plan cortado.
 */
function moneyScore(cop: number): number {
  const magnitude = Math.log10(Math.max(cop, 1)) - 5;
  return 60 + Math.max(0, Math.min(3, magnitude)) * 10;
}

const clamp = (n: number, max: number) => Math.max(0, Math.min(max, n));

/** Las cosas de UNA fila que merecen estar en la lista, ya con su puntaje. */
export function actionCandidates(
  row: Pick<ConsoleRow, 'id' | 'name' | 'kind' | 'owned' | 'pulse'> & {
    health: StatusRow['health'];
  },
  business: CompanyBusiness | null | undefined,
  now: Date = new Date(),
): ActionItem[] {
  const out: ActionItem[] = [];
  const make = (
    kind: ActionKind,
    text: string,
    cta: string,
    path: string,
    tone: ActionItem['tone'],
    score: number,
  ) =>
    out.push({
      id: `${row.id}:${kind}`,
      kind,
      companyId: row.id,
      companyName: row.name,
      text,
      cta,
      path,
      href: workspaceHref(row.id, path),
      tone,
      score: Math.round(score * 10) / 10,
    });

  const health = row.health;
  if (health?.subscriptionStatus === 'past_due' || health?.subscriptionStatus === 'canceled')
    make('billing', 'el pago del plan está pendiente', 'Pagar', '/plan', 'rose', 95);
  else if (health?.answers?.state === 'blocked')
    make('billing', 'se acabaron las respuestas del mes', 'Ver plan', '/plan', 'rose', 94);

  if (business?.risk) {
    const risk = business.risk;
    if (risk.receivablesOverdue > 0)
      make(
        'receivables',
        `${compactCop(risk.receivablesOverdue)} vencidos, ${plural(risk.overdueInvoices, 'factura', 'facturas')}`,
        'Cobrar',
        '/payments',
        'rose',
        moneyScore(risk.receivablesOverdue),
      );
    else if (risk.others.length > 0) {
      const top = risk.others[0];
      if (top)
        make(
          'receivables',
          `${otherCurrency(top.amount, top.currency)} vencidos, ${plural(top.invoices, 'factura', 'facturas')}`,
          'Cobrar',
          '/payments',
          'rose',
          65,
        );
    }
    const toPay = risk.paymentsOverdue + risk.paymentsDueSoon + risk.finesPending;
    if (toPay > 0)
      make(
        'payments',
        risk.paymentsOverdue > 0
          ? `${compactCop(risk.paymentsOverdue)} en pagos vencidos`
          : `${compactCop(toPay)} por pagar esta semana`,
        'Ver pagos',
        '/commitments',
        risk.paymentsOverdue > 0 ? 'rose' : 'amber',
        // Un pago vencido cuesta intereses o cortes hoy; uno que vence esta
        // semana todavía es un recordatorio, y no debe tapar a quien espera.
        risk.paymentsOverdue > 0 ? moneyScore(toPay) - 2 : 40 + (moneyScore(toPay) - 60) / 2,
      );
  }

  if (business?.failing && business.failing.total > 0) {
    const n = business.failing.total;
    make(
      'failing',
      `${plural(n, 'proceso fallando', 'procesos fallando')}`,
      'Arreglar',
      '/procesos',
      'amber',
      72 + 3 * clamp(n, 5),
    );
  }

  if (row.pulse.status === 'ready') {
    const decisions = row.pulse.approvals + row.pulse.actions;
    if (decisions > 0) {
      const waited = daysSince(business?.oldestDecisionAt ?? null, now);
      make(
        'decisions',
        `${plural(decisions, 'decisión esperando', 'decisiones esperando')}${waited !== null && waited >= 1 ? ` ${waitedPhrase(waited)}` : ''}`,
        'Decidir',
        '/approvals',
        waited !== null && waited >= STALE_DECISION_DAYS ? 'amber' : 'primary',
        50 + 4 * clamp(waited ?? 0, 5) + clamp(decisions, 10),
      );
    }
    const blocked = row.pulse.blocked ?? 0;
    if (blocked > 0)
      make(
        'blocked',
        plural(blocked, 'asunto bloqueado', 'asuntos bloqueados'),
        'Destrabar',
        '/errands',
        'amber',
        55 + 3 * clamp(blocked, 3),
      );
    const deadlines = row.pulse.deadlines ?? 0;
    if (deadlines > 0)
      make(
        'deadlines',
        plural(deadlines, 'vencimiento por atender', 'vencimientos por atender'),
        'Ver fechas',
        '/commitments',
        'amber',
        52 + 2 * clamp(deadlines, 5),
      );
  } else if (row.kind === 'company') {
    make('unreadable', 'no respondió; sus cifras no están', 'Abrir', '/dashboard', 'neutral', 20);
  }

  if (row.owned && business?.setup && business.setup.percent < SETUP_STARTING_PERCENT) {
    make(
      'setup',
      `puesta en marcha al ${business.setup.percent} %${business.setup.next ? ` · sigue: ${business.setup.next.toLowerCase()}` : ''}`,
      'Seguir',
      '/dashboard',
      'primary',
      30 + (SETUP_STARTING_PERCENT - business.setup.percent) / 10,
    );
  }

  return out;
}

/**
 * Las `limit` cosas más importantes entre todas las empresas.
 *
 * Mayor puntaje primero; a igual puntaje, el nombre de la empresa (para que la
 * lista no baile entre recargas). Como mucho `perCompany` por empresa: cinco
 * renglones de la misma empresa dicen menos que «entra a esa», y esconden la
 * segunda empresa con problemas — si no hay más empresas con algo, se rellena
 * con lo que quedó.
 */
export function rankActionItems(
  entries: ReadonlyArray<{
    row: Parameters<typeof actionCandidates>[0];
    business: CompanyBusiness | null | undefined;
  }>,
  opts: { now?: Date; limit?: number; perCompany?: number } = {},
): ActionItem[] {
  const now = opts.now ?? new Date();
  const limit = opts.limit ?? 5;
  const perCompany = opts.perCompany ?? 2;
  const all = entries
    .filter((entry) => entry.row.kind === 'company')
    .flatMap((entry) => actionCandidates(entry.row, entry.business, now))
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.companyName.localeCompare(b.companyName, 'es') ||
        a.kind.localeCompare(b.kind),
    );
  const picked: ActionItem[] = [];
  const perCount = new Map<string, number>();
  const skipped: ActionItem[] = [];
  for (const item of all) {
    if (picked.length >= limit) break;
    const n = perCount.get(item.companyId) ?? 0;
    if (n >= perCompany) {
      skipped.push(item);
      continue;
    }
    perCount.set(item.companyId, n + 1);
    picked.push(item);
  }
  for (const item of skipped) {
    if (picked.length >= limit) break;
    picked.push(item);
  }
  return picked.sort((a, b) => b.score - a.score);
}

/* ------------------------------------------------------------------------- */
/* Totales                                                                   */
/* ------------------------------------------------------------------------- */

export interface BusinessTotals {
  /** Empresas propias que se intentaron leer. */
  owned: number;
  riskCop: number;
  riskOthers: Array<{ currency: string; amount: number }>;
  /** De cuántas empresas propias falta la plata en riesgo. */
  riskMissing: number;
  recoveredCop: number;
  recoveredMissing: number;
  /** Decisiones que esperan a quien mira, en TODOS sus espacios. */
  decisions: number;
  failing: number;
  failingMissing: number;
  /** Empresas (propias o no) cuyo estado es «Pide atención». */
  attention: number;
}

export function businessTotals(
  rows: ReadonlyArray<ConsoleRow>,
  business: BusinessMap | null,
  now: Date = new Date(),
): BusinessTotals {
  const totals: BusinessTotals = {
    owned: 0,
    riskCop: 0,
    riskOthers: [],
    riskMissing: 0,
    recoveredCop: 0,
    recoveredMissing: 0,
    decisions: 0,
    failing: 0,
    failingMissing: 0,
    attention: 0,
  };
  const others = new Map<string, number>();
  for (const row of rows) {
    if (row.pulse.status === 'ready') totals.decisions += row.pulse.approvals + row.pulse.actions;
    const b = row.owned ? (business?.[row.id] ?? null) : undefined;
    if (row.kind === 'company' && companyStatus(row, b, now).label === 'Pide atención')
      totals.attention += 1;
    if (!row.owned) continue;
    totals.owned += 1;
    if (b?.risk) {
      totals.riskCop += b.risk.total;
      for (const o of b.risk.others)
        others.set(o.currency, (others.get(o.currency) ?? 0) + o.amount);
    } else totals.riskMissing += 1;
    if (b?.recovered) totals.recoveredCop += b.recovered.month;
    else totals.recoveredMissing += 1;
    if (b?.failing) totals.failing += b.failing.total;
    else totals.failingMissing += 1;
  }
  totals.riskOthers = [...others.entries()]
    .map(([currency, amount]) => ({ currency, amount }))
    .sort((a, b) => b.amount - a.amount);
  return totals;
}

/* ------------------------------------------------------------------------- */
/* La marca                                                                  */
/* ------------------------------------------------------------------------- */

/** «TA» para Transportes Andinos, «Z» para Zeta. Sin artículos ni sociedades. */
export function initialsOf(name: string): string {
  const skip = new Set([
    'de',
    'del',
    'la',
    'las',
    'los',
    'el',
    'y',
    'sas',
    's.a.s.',
    'sa',
    's.a.',
    'ltda',
  ]);
  const words = name
    .trim()
    .split(/\s+/)
    .filter((w) => w && !skip.has(w.toLowerCase()));
  const letters = words.slice(0, 2).map((w) => w.charAt(0).toUpperCase());
  return letters.join('') || name.trim().charAt(0).toUpperCase() || '·';
}

/** Un color de marca válido (#rgb o #rrggbb), o `null`. Nada que no sea eso llega al estilo. */
export function safeBrandColor(color: string | null | undefined): string | null {
  return typeof color === 'string' && /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(color.trim())
    ? color.trim()
    : null;
}

/** El prompt de «Ver su pulso» cuando la empresa todavía no tiene la vista. */
export function pulsePrompt(name: string): string {
  return `Dime cómo va la empresa ${name}: ventas, cartera, pendientes y procesos.`;
}

/** Dónde se ve el pulso de una empresa: su vista si existe; si no, se le pregunta a Cortex. */
export function pulseHref(companyId: string, name: string, hasView: boolean | null): string {
  return hasView
    ? workspaceHref(companyId, '/views/pulso_empresa')
    : workspaceHref(companyId, `/chat?prompt=${encodeURIComponent(pulsePrompt(name))}`);
}

/** Tinta legible sobre un color de marca: oscura sobre amarillos y claros, blanca sobre el resto. */
export function inkOn(color: string): '#17171F' | '#FFFFFF' {
  let hex = color.replace('#', '');
  if (hex.length === 3)
    hex = hex
      .split('')
      .map((c) => c + c)
      .join('');
  const channel = (i: number) => {
    const v = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
  return luminance > 0.2 ? '#17171F' : '#FFFFFF';
}
