import { COUNTED_STATES, type PaymentKind, type PaymentState } from './shape';

/**
 * PLATA RECUPERADA CON CORTEX: LA CIFRA QUE PRUEBA EL VALOR, Y SUS REGLAS.
 *
 * «Plata en riesgo» (risk.ts) dice cuánto se está jugando. Esto dice cuánto
 * VOLVIÓ después de que Cortex hizo algo por esa factura. Es la cifra que un
 * gerente usa para decidir si Cortex vale lo que cuesta, así que tiene que ser
 * una cifra que aguante a un contador escéptico: CONSERVADORA (ante la duda, no
 * cuenta), AUDITABLE (cada peso dice qué pago, qué día y después de qué acción
 * de Cortex) y SIN DOBLE CONTEO (cada pago entra una vez).
 *
 * Todo lo de este archivo es puro: recibe filas ya leídas y devuelve la cifra.
 * La lectura vive en recovered-store.ts. Así las reglas se prueban sin base.
 *
 * QUÉ CUENTA COMO «ACCIÓN DE CORTEX» SOBRE UNA FACTURA (de más a menos fuerte):
 *
 *   1. COBRO ENVIADO: un correo de cobro que Cortex preparó, una persona aprobó
 *      y salió (`actions`, `collect_payment`, `execution_status = 'ok'`), atado
 *      a la factura por el proceso de cobro de Gerencia (0131).
 *   2. SEGUIMIENTO EN GERENCIA: el asunto empezó un proceso de cobro sobre esa
 *      factura (`management_workflows`).
 *   3. AVISO DE MORA: el vigilante de cartera avisó del escalón de mora de esa
 *      factura (`receivable_notices`, 0159/0165).
 *
 * QUÉ CUENTA COMO «PLATA QUE VOLVIÓ»:
 *
 *   - Un pago (`kind = 'payment'`) en estado contado por la cartera (reportado o
 *     confirmado; uno en disputa o descartado no está en ninguna cifra),
 *     atado a ESA factura: por su id de documento, o —para las de un programa
 *     contable— por su número, y sólo si ese número nombra una única factura.
 *   - Con la MISMA moneda de la factura. Nunca se cruzan monedas.
 *   - Pagado DESPUÉS del día de la acción (estrictamente: el mismo día no
 *     cuenta, porque no sabemos qué fue primero) y a más tardar
 *     `RECOVERY_WINDOW_DAYS` días después.
 *   - Nunca más de lo que todavía se debía en ese momento. Un pago parcial
 *     cuenta parcial; un pago que cubre de más cuenta hasta el saldo.
 *   - Una devolución (`reversal`) posterior descuenta lo ya contado.
 *   - Un `adjustment` no es plata que entró: no cuenta.
 *
 *   - SÓLO para facturas de un programa contable que NO trae sus pagos: una
 *     caída de saldo observada por el vigilante (`receivable_balance_drops`,
 *     0166). Si el programa trae pagos, los pagos mandan y una caída de saldo
 *     sin pago es casi siempre una nota crédito, que no es plata. Y si la
 *     factura tiene pagos atados, también mandan los pagos.
 *
 * CUANDO VARIAS ACCIONES PRECEDEN UN PAGO se atribuye a la más fuerte dentro de
 * la ventana y, entre iguales, a la más reciente. Es una sola atribución por
 * pago: el pago no se reparte ni se cuenta dos veces.
 *
 * LO MANUAL. Al cerrar un asunto de Gerencia con evidencia, un administrador
 * puede anotar «plata recuperada o ahorrada» en pesos (una multa evitada, un
 * descuento negociado). Cuenta sólo cuando el asunto está cerrado con
 * verificación humana. Si el asunto tiene un proceso de cobro cuya factura ya
 * sumó pagos atribuidos, lo manual cuenta sólo por encima de esos pagos: el
 * mismo peso no entra por las dos puertas.
 */

export const RECOVERY_WINDOW_DAYS = 45;

export type RecoveryTriggerKind = 'collection' | 'case' | 'notice';

export const RECOVERY_TRIGGER_STRENGTH: Record<RecoveryTriggerKind, number> = {
  collection: 3,
  case: 2,
  notice: 1,
};

export const RECOVERY_TRIGGER_LABEL: Record<RecoveryTriggerKind, string> = {
  collection: 'Cobro enviado por Cortex',
  case: 'Seguimiento de cobro en Gerencia',
  notice: 'Aviso de mora de Cortex',
};

export interface RecoveryInvoice {
  id: string;
  source: 'document' | 'accounting';
  /** El programa contable ('siigo'), cuando `source` es 'accounting'. */
  system: string | null;
  docNumber: string | null;
  clientId: string | null;
  counterparty: string | null;
  currency: string;
  total: number;
  /**
   * Sólo programa contable: el programa trae sus pagos a Pagos. Entonces una
   * caída de saldo sin pago no cuenta (es una nota crédito o una corrección).
   */
  paymentsSynced?: boolean;
  /** Enlace a la factura, si existe (la del programa contable). */
  href?: string | null;
}

export interface RecoveryTrigger {
  kind: RecoveryTriggerKind;
  /** El id de la fila que lo prueba: el aviso, el proceso o la acción. */
  id: string;
  invoiceId: string;
  /** El día de Bogotá en que Cortex actuó. */
  on: string;
  /** Lo que se debía en ese momento, cuando quedó escrito (avisos desde la 0166). */
  balance?: number | null;
  caseId?: string | null;
  /** Escalón de mora, para un aviso. */
  stage?: number | null;
  href: string;
}

export interface RecoveryPayment {
  id: string;
  extractionId: string | null;
  invoiceNumber: string | null;
  kind: PaymentKind;
  amount: number;
  currency: string;
  paidOn: string;
  state: PaymentState;
}

export interface RecoveryBalanceDrop {
  id: string;
  invoiceId: string;
  amount: number;
  currency: string;
  /** El día en que se vio el saldo de antes: el saldo seguía alto ese día. */
  seenBeforeOn: string;
  /** El día en que se vio el saldo bajar. */
  observedOn: string;
}

export interface ManualRecoveryInput {
  caseId: string;
  title: string;
  amountCop: number;
  note: string;
  /** El día de Bogotá del cierre verificado. */
  on: string;
  /** La factura del proceso de cobro del asunto, si tiene uno. */
  invoiceId?: string | null;
}

export interface RecoveryTriggerRef {
  kind: RecoveryTriggerKind;
  label: string;
  id: string;
  on: string;
  href: string;
  caseId: string | null;
  stage: number | null;
}

export interface RecoveredMovement {
  kind: 'payment' | 'reversal' | 'balance_drop';
  /** El pago o la caída de saldo que lo prueba. */
  id: string;
  on: string;
  /** Lo que se cuenta: positivo para un pago, negativo para una devolución. */
  counted: number;
  /** Lo que decía el movimiento, antes de topar al saldo. */
  reported: number;
  trigger: RecoveryTriggerRef;
}

export interface RecoveredInvoice {
  invoiceId: string;
  source: 'document' | 'accounting';
  system: string | null;
  docNumber: string | null;
  clientId: string | null;
  counterparty: string | null;
  currency: string;
  href: string | null;
  /** Lo recuperado, neto de devoluciones. */
  amount: number;
  firstOn: string;
  lastOn: string;
  /** La primera acción de Cortex a la que se atribuyó plata. */
  trigger: RecoveryTriggerRef;
  /** Cuántas acciones distintas de Cortex sumaron plata en esta factura. */
  triggers: number;
  /** Algún pago cubría más de lo que se debía y se contó sólo hasta el saldo. */
  capped: boolean;
  movements: RecoveredMovement[];
}

export interface ManualRecovered {
  caseId: string;
  title: string;
  note: string;
  amountCop: number;
  /** Lo que entra en la cifra: lo declarado menos lo que ya contaron los pagos. */
  counted: number;
  /** Lo que ya habían contado los pagos atribuidos de la factura del asunto. */
  overlap: number;
  on: string;
  href: string;
}

export interface MoneyRecovered {
  today: string;
  month: string;
  windowDays: number;
  cop: {
    /** Recuperado este mes (Bogotá): pagos atribuidos + lo manual verificado. */
    month: number;
    total: number;
    automatic: number;
    manual: number;
    invoices: number;
    monthInvoices: number;
    manualCases: number;
  };
  /** Lo recuperado en otras monedas, cada una por su lado. Nunca se suma a los pesos. */
  otherCurrencies: Array<{ currency: string; month: number; total: number; invoices: number }>;
  /** Por factura, lo más reciente primero. */
  items: RecoveredInvoice[];
  manual: ManualRecovered[];
  /** Las reglas en una frase, para la pantalla y para el modelo. */
  rules: string;
}

export interface AttributeRecoveredInput {
  today: string;
  windowDays?: number;
  invoices: RecoveryInvoice[];
  triggers: RecoveryTrigger[];
  payments: RecoveryPayment[];
  drops?: RecoveryBalanceDrop[];
  manual?: ManualRecoveryInput[];
}

const EPS = 0.005;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function validDay(day: string | null | undefined): day is string {
  return (
    typeof day === 'string' && DAY_RE.test(day) && !Number.isNaN(Date.parse(`${day}T12:00:00Z`))
  );
}

export function addDaysTo(day: string, days: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** «FV-2-22», «fv 2 22» y «FV2-22» son el mismo número (igual que la cartera). */
function numberKey(raw: string | null | undefined): string {
  return (raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function currencyOf(raw: string): string {
  return raw.trim().toUpperCase();
}

/** Centavos exactos: sumar 0,1 + 0,2 no puede dar 0,30000000000000004 pesos. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function refOf(t: RecoveryTrigger): RecoveryTriggerRef {
  return {
    kind: t.kind,
    label: RECOVERY_TRIGGER_LABEL[t.kind],
    id: t.id,
    on: t.on,
    href: t.href,
    caseId: t.caseId ?? null,
    stage: t.stage ?? null,
  };
}

/**
 * La acción de Cortex a la que se atribuye algo que pasó el día `on`, o null.
 *
 * `after(t)` dice si el hecho es posterior a la acción: para un pago, el día
 * del pago es estrictamente posterior; para una caída de saldo, el saldo
 * todavía estaba alto el día de la acción o después.
 */
export function pickTrigger(
  triggers: readonly RecoveryTrigger[],
  on: string,
  windowDays: number,
  after: (t: RecoveryTrigger) => boolean = (t) => t.on < on,
): RecoveryTrigger | null {
  let best: RecoveryTrigger | null = null;
  for (const t of triggers) {
    if (!after(t)) continue;
    if (on > addDaysTo(t.on, windowDays)) continue;
    if (
      !best ||
      RECOVERY_TRIGGER_STRENGTH[t.kind] > RECOVERY_TRIGGER_STRENGTH[best.kind] ||
      (RECOVERY_TRIGGER_STRENGTH[t.kind] === RECOVERY_TRIGGER_STRENGTH[best.kind] &&
        (t.on > best.on || (t.on === best.on && t.id > best.id)))
    )
      best = t;
  }
  return best;
}

type Event =
  | { type: 'snapshot'; on: string; balance: number; id: string }
  | { type: 'payment'; on: string; payment: RecoveryPayment };

/**
 * Lo atribuido a UNA factura. Recorre su historia en orden: el saldo empieza en
 * el total, cada pago lo baja (cuente o no), cada aviso con saldo escrito lo
 * fija a lo que se sabía ese día, y un pago cuenta sólo si una acción de Cortex
 * lo precede dentro de la ventana, y sólo hasta lo que todavía se debía.
 */
function attributeInvoice(
  invoice: RecoveryInvoice,
  triggers: RecoveryTrigger[],
  payments: RecoveryPayment[],
  drops: RecoveryBalanceDrop[],
  windowDays: number,
  today: string,
): RecoveredInvoice | null {
  const movements: RecoveredMovement[] = [];
  let capped = false;

  const events: Event[] = [];
  for (const t of triggers)
    if (t.balance != null && Number.isFinite(t.balance) && t.balance >= 0)
      events.push({ type: 'snapshot', on: t.on, balance: t.balance, id: t.id });
  for (const p of payments) events.push({ type: 'payment', on: p.paidOn, payment: p });
  // El mismo día, el saldo escrito por el aviso va antes que los pagos de ese
  // día: si el pago fue en realidad anterior, se resta dos veces y se cuenta
  // de menos, nunca de más.
  events.sort(
    (a, b) =>
      a.on.localeCompare(b.on) ||
      (a.type === b.type ? 0 : a.type === 'snapshot' ? -1 : 1) ||
      (a.type === 'payment' && b.type === 'payment' ? a.payment.id.localeCompare(b.payment.id) : 0),
  );

  let owed = invoice.total;
  let acc = 0;
  let lastTrigger: RecoveryTrigger | null = null;
  const earliest = triggers.reduce<string | null>(
    (min, t) => (min == null || t.on < min ? t.on : min),
    null,
  );

  for (const e of events) {
    if (e.type === 'snapshot') {
      owed = e.balance;
      continue;
    }
    const p = e.payment;
    if (p.kind === 'payment') {
      const t = pickTrigger(triggers, p.paidOn, windowDays);
      const room = Math.max(0, owed);
      owed -= p.amount;
      if (!t || room <= EPS) continue;
      const counted = round2(Math.min(p.amount, room));
      if (counted + EPS < p.amount) capped = true;
      acc = round2(acc + counted);
      lastTrigger = t;
      movements.push({
        kind: 'payment',
        id: p.id,
        on: p.paidOn,
        counted,
        reported: p.amount,
        trigger: refOf(t),
      });
    } else if (p.kind === 'reversal') {
      owed += p.amount;
      // Sólo descuenta lo ya contado, y sólo si llegó después de una acción.
      if (acc <= EPS || !lastTrigger || earliest == null || p.paidOn <= earliest) continue;
      const back = round2(Math.min(p.amount, acc));
      acc = round2(acc - back);
      movements.push({
        kind: 'reversal',
        id: p.id,
        on: p.paidOn,
        counted: -back,
        reported: p.amount,
        trigger: refOf(lastTrigger),
      });
    }
  }

  // La caída de saldo: sólo programa contable que no trae pagos, y sólo si la
  // factura no tiene ningún pago atado (los pagos mandan).
  if (invoice.source === 'accounting' && invoice.paymentsSynced !== true && payments.length === 0) {
    const sorted = [...drops].sort(
      (a, b) => a.observedOn.localeCompare(b.observedOn) || a.id.localeCompare(b.id),
    );
    for (const d of sorted) {
      if (d.observedOn > today) continue;
      const t = pickTrigger(triggers, d.observedOn, windowDays, (tr) => tr.on <= d.seenBeforeOn);
      if (!t) continue;
      const counted = round2(Math.min(d.amount, Math.max(0, invoice.total - acc)));
      if (counted <= EPS) continue;
      if (counted + EPS < d.amount) capped = true;
      acc = round2(acc + counted);
      movements.push({
        kind: 'balance_drop',
        id: d.id,
        on: d.observedOn,
        counted,
        reported: d.amount,
        trigger: refOf(t),
      });
    }
  }

  if (acc <= EPS || movements.length === 0) return null;
  const first = movements.find((m) => m.counted > 0) ?? movements[0];
  if (!first) return null;
  return {
    invoiceId: invoice.id,
    source: invoice.source,
    system: invoice.system,
    docNumber: invoice.docNumber,
    clientId: invoice.clientId,
    counterparty: invoice.counterparty,
    currency: currencyOf(invoice.currency),
    href: invoice.href ?? null,
    amount: acc,
    firstOn: first.on,
    lastOn: movements[movements.length - 1]?.on ?? first.on,
    trigger: first.trigger,
    triggers: new Set(movements.map((m) => `${m.trigger.kind}:${m.trigger.id}`)).size,
    capped,
    movements,
  };
}

/**
 * La cifra entera. Pura: misma entrada, misma salida, sin reloj ni base.
 */
export function attributeRecovered(input: AttributeRecoveredInput): MoneyRecovered {
  const windowDays = input.windowDays ?? RECOVERY_WINDOW_DAYS;
  const today = input.today;
  const month = today.slice(0, 7);

  const invoices = new Map<string, RecoveryInvoice>();
  for (const inv of input.invoices) {
    if (!Number.isFinite(inv.total) || inv.total <= 0) continue;
    if (!/^[A-Z]{3}$/.test(currencyOf(inv.currency))) continue;
    invoices.set(inv.id, inv);
  }

  // Número → factura del programa contable. Un número que nombra dos facturas
  // no ata ningún pago: ante la duda, no cuenta.
  const byNumber = new Map<string, string | null>();
  for (const inv of invoices.values()) {
    if (inv.source !== 'accounting') continue;
    const key = numberKey(inv.docNumber);
    if (!key) continue;
    byNumber.set(key, byNumber.has(key) ? null : inv.id);
  }

  const triggersBy = new Map<string, RecoveryTrigger[]>();
  for (const t of input.triggers) {
    if (!invoices.has(t.invoiceId) || !validDay(t.on) || t.on > today) continue;
    const list = triggersBy.get(t.invoiceId) ?? [];
    list.push(t);
    triggersBy.set(t.invoiceId, list);
  }

  // Cada pago una vez, atado a una sola factura.
  const counted = new Set<string>(COUNTED_STATES);
  const seen = new Set<string>();
  const paymentsBy = new Map<string, RecoveryPayment[]>();
  for (const p of input.payments) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    if (!counted.has(p.state)) continue;
    if (p.kind !== 'payment' && p.kind !== 'reversal') continue;
    if (!Number.isFinite(p.amount) || p.amount <= 0) continue;
    if (!validDay(p.paidOn) || p.paidOn > today) continue;
    let invoiceId: string | null = null;
    if (p.extractionId) {
      const inv = invoices.get(p.extractionId);
      invoiceId = inv?.source === 'document' ? inv.id : null;
    } else {
      invoiceId = byNumber.get(numberKey(p.invoiceNumber)) ?? null;
    }
    if (!invoiceId) continue;
    const inv = invoices.get(invoiceId);
    if (!inv || currencyOf(inv.currency) !== currencyOf(p.currency)) continue;
    const list = paymentsBy.get(invoiceId) ?? [];
    list.push(p);
    paymentsBy.set(invoiceId, list);
  }

  const dropsBy = new Map<string, RecoveryBalanceDrop[]>();
  const seenDrops = new Set<string>();
  for (const d of input.drops ?? []) {
    if (seenDrops.has(d.id)) continue;
    seenDrops.add(d.id);
    const inv = invoices.get(d.invoiceId);
    if (!inv || inv.source !== 'accounting') continue;
    if (currencyOf(inv.currency) !== currencyOf(d.currency)) continue;
    if (!Number.isFinite(d.amount) || d.amount <= 0) continue;
    if (!validDay(d.observedOn) || !validDay(d.seenBeforeOn)) continue;
    const list = dropsBy.get(d.invoiceId) ?? [];
    list.push(d);
    dropsBy.set(d.invoiceId, list);
  }

  const items: RecoveredInvoice[] = [];
  for (const [invoiceId, triggers] of triggersBy) {
    const inv = invoices.get(invoiceId);
    if (!inv) continue;
    const item = attributeInvoice(
      inv,
      triggers,
      paymentsBy.get(invoiceId) ?? [],
      dropsBy.get(invoiceId) ?? [],
      windowDays,
      today,
    );
    if (item) items.push(item);
  }
  items.sort(
    (a, b) =>
      b.lastOn.localeCompare(a.lastOn) ||
      b.amount - a.amount ||
      a.invoiceId.localeCompare(b.invoiceId),
  );

  // Lo automático en pesos, por factura: lo que lo manual no puede repetir.
  const copByInvoice = new Map<string, number>();
  for (const it of items) if (it.currency === 'COP') copByInvoice.set(it.invoiceId, it.amount);

  const manual: ManualRecovered[] = [];
  const seenCases = new Set<string>();
  for (const m of input.manual ?? []) {
    if (seenCases.has(m.caseId)) continue;
    seenCases.add(m.caseId);
    if (!Number.isFinite(m.amountCop) || m.amountCop <= 0 || !validDay(m.on) || m.on > today)
      continue;
    const overlap = m.invoiceId ? (copByInvoice.get(m.invoiceId) ?? 0) : 0;
    manual.push({
      caseId: m.caseId,
      title: m.title,
      note: m.note,
      amountCop: m.amountCop,
      counted: round2(Math.max(0, m.amountCop - overlap)),
      overlap: round2(Math.min(overlap, m.amountCop)),
      on: m.on,
      href: `/management?case=${m.caseId}`,
    });
  }
  manual.sort((a, b) => b.on.localeCompare(a.on) || b.counted - a.counted);

  // Las cifras. El mes se cuenta por el día de cada movimiento, no de la factura.
  const buckets = new Map<
    string,
    { month: number; total: number; invoices: number; monthInvoices: number }
  >();
  for (const it of items) {
    const b = buckets.get(it.currency) ?? { month: 0, total: 0, invoices: 0, monthInvoices: 0 };
    b.total = round2(b.total + it.amount);
    b.invoices += 1;
    const inMonth = it.movements.filter((m) => m.on.startsWith(month));
    if (inMonth.length) {
      b.month = round2(b.month + inMonth.reduce((s, m) => s + m.counted, 0));
      b.monthInvoices += 1;
    }
    buckets.set(it.currency, b);
  }
  const copAuto = buckets.get('COP') ?? { month: 0, total: 0, invoices: 0, monthInvoices: 0 };
  const manualTotal = round2(manual.reduce((s, m) => s + m.counted, 0));
  const manualMonth = round2(
    manual.filter((m) => m.on.startsWith(month)).reduce((s, m) => s + m.counted, 0),
  );

  return {
    today,
    month,
    windowDays,
    cop: {
      month: round2(Math.max(0, copAuto.month) + manualMonth),
      total: round2(copAuto.total + manualTotal),
      automatic: copAuto.total,
      manual: manualTotal,
      invoices: copAuto.invoices,
      monthInvoices: copAuto.monthInvoices,
      manualCases: manual.filter((m) => m.counted > 0).length,
    },
    otherCurrencies: [...buckets.entries()]
      .filter(([currency]) => currency !== 'COP')
      .map(([currency, b]) => ({
        currency,
        month: Math.max(0, b.month),
        total: b.total,
        invoices: b.invoices,
      }))
      .sort((a, b) => b.total - a.total),
    items,
    manual,
    rules: recoveryRulesSentence(windowDays),
  };
}

export function recoveryRulesSentence(windowDays = RECOVERY_WINDOW_DAYS): string {
  return `Cuenta un pago atado a una factura que llegó después de que Cortex actuó sobre ella (cobro enviado, seguimiento en Gerencia o aviso de mora), a más tardar ${windowDays} días después, sólo hasta lo que se debía y una sola vez. Lo manual cuenta sólo en asuntos cerrados con verificación de un administrador. Los pagos en disputa no cuentan y las monedas no se mezclan.`;
}
