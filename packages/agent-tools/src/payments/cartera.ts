/**
 * LA CARTERA, ARMADA PARA LEERSE (puro: sin base de datos, sin reloj).
 *
 * `receivables()` (store.ts) da UNA cifra honesta para el chat y los avisos.
 * Esto es lo que necesita la pantalla de Cartera: la misma plata, pero cortada
 * por antigüedad, por cliente, por mes y por semana, con a qué factura fue cada
 * recibo. Recibe filas ya leídas (las lee `cartera-read.ts`) y devuelve un
 * modelo plano que el navegador pinta sin sumar nada.
 *
 * LO QUE ESTA FUNCIÓN DECIDE, Y POR QUÉ (cada punto salió de un dato real de
 * Siigo, no de una suposición):
 *
 *  1. EL SALDO ES EL QUE DICE EL PROGRAMA CONTABLE. Siigo ya descuenta en
 *     `balance` los recibos aplicados, los cruces de anticipos y las notas
 *     crédito (se comprobó: facturado = por cobrar + cruzado + notas crédito,
 *     al peso). Aquí no se resta nada otra vez.
 *
 *  2. UN RECIBO «ANTICIPO» NO PAGA UNA FACTURA. En Siigo su línea `due` apunta al
 *     propio recibo («RC-1-4»), así que «a qué factura abona» no tiene
 *     respuesta: es plata del cliente que se cruza después contra facturas
 *     (cuenta 2805 → 1305). Se muestra como anticipo —cruzado o por aplicar—,
 *     nunca como «pago sin emparejar».
 *
 *  3. UN RECIBO QUE NOMBRA UNA FACTURA SE ATRIBUYE A ELLA. Uno que no nombra
 *     ninguna queda «sin emparejar» y se le SUGIERE la factura abierta más
 *     antigua del mismo cliente (FIFO), marcada como sugerencia: nunca se aplica
 *     sola.
 *
 *  4. EL VENCIMIENTO ES EL DE SIIGO CUANDO ES UN PLAZO DE VERDAD. Si Siigo trae
 *     vence <= fecha de la factura (sin plazo) se usa el plazo del cliente; sin
 *     plazo, la factura queda en «Sin plazo definido» y NO cuenta como vencida:
 *     decir que todo está vencido porque nadie escribió el plazo es mentir en
 *     la dirección contraria. `defaultTermDays` deja ver «qué pasaría con N días».
 *
 *  5. «DÍAS PROMEDIO DE COBRO» ES EL DSO: por cobrar / facturado de los últimos
 *     90 días × 90. «A 27 días» era la edad media de las facturas desde que se
 *     expidieron, que no dice nada de cuánto se tarda en cobrar.
 */

export type CarteraBucketKey = 'current' | 'd1_30' | 'd31_60' | 'd61_90' | 'd90_plus' | 'no_term';

export const BUCKET_ORDER: CarteraBucketKey[] = [
  'current',
  'd1_30',
  'd31_60',
  'd61_90',
  'd90_plus',
  'no_term',
];

export const BUCKET_LABEL: Record<CarteraBucketKey, string> = {
  current: 'Al día',
  d1_30: '1 a 30 días',
  d31_60: '31 a 60 días',
  d61_90: '61 a 90 días',
  d90_plus: 'Más de 90 días',
  no_term: 'Sin plazo definido',
};

// ---------------------------------------------------------------------------
// Entrada
// ---------------------------------------------------------------------------

export interface CarteraInvoiceIn {
  id: string;
  kind: 'accounting' | 'document';
  docNumber: string;
  /** Llave canónica del cliente (id, o NIT, o nombre): la pone quien lee. */
  clientKey: string;
  clientId: string | null;
  clientName: string;
  currency: string;
  total: number;
  /** Lo que falta por cobrar, tal como lo dice la fuente. */
  balance: number;
  issuedOn: string;
  dueOn: string | null;
  einvoice?: string | null;
  url?: string | null;
}

export interface CarteraPaymentIn {
  id: string;
  kind: 'payment' | 'reversal' | 'adjustment';
  amount: number;
  currency: string;
  paidOn: string;
  clientKey: string | null;
  clientName: string | null;
  /** Lo que el pago dice pagar (puede ser el propio recibo, en un anticipo). */
  invoiceNumber: string | null;
  /** El número del recibo («RC-1-4»). */
  reference: string | null;
  state?: string;
}

export interface CarteraCreditNoteIn {
  number: string;
  invoiceNumber: string | null;
  amount: number;
  date: string;
  clientKey: string | null;
  clientName: string | null;
}

export interface CarteraInput {
  today: string;
  /** La moneda de la cifra. Las demás se cuentan aparte, jamás se mezclan. */
  currency?: string;
  invoices: CarteraInvoiceIn[];
  payments: CarteraPaymentIn[];
  creditNotes?: CarteraCreditNoteIn[];
  /** Números de recibo que Siigo marca como «Anticipo». */
  advanceReceipts?: string[];
  /** Plazo pactado con cada cliente, en días, por llave de cliente. */
  termDays?: Record<string, number>;
  /** «¿Y si las facturas sin plazo se cobraran a N días?». Sólo para mirar. */
  defaultTermDays?: number | null;
  /**
   * Lo que dice la contabilidad: anticipos ya cruzados (débitos de 2805) por
   * cliente, créditos de 1305 con fecha, y el saldo de la 1305 por cliente
   * si Siigo ya entregó los saldos por tercero.
   */
  ledger?: {
    advanceCrossedByClient?: Record<string, number>;
    receivableCredits?: Array<{ date: string; amount: number }>;
    balance1305ByClient?: Record<string, number>;
    balancePeriod?: string | null;
  } | null;
}

// ---------------------------------------------------------------------------
// Salida
// ---------------------------------------------------------------------------

export type DueBasis = 'siigo' | 'plazo_cliente' | 'plazo_supuesto' | 'sin_plazo';

export interface CarteraInvoice {
  id: string;
  kind: 'accounting' | 'document';
  docNumber: string;
  clientKey: string;
  clientName: string;
  issuedOn: string;
  dueOn: string | null;
  dueBasis: DueBasis;
  /** Positivo = días vencida; negativo = faltan; null = sin plazo. */
  daysOverdue: number | null;
  ageDays: number;
  total: number;
  balance: number;
  bucket: CarteraBucketKey;
  einvoice: string | null;
  url: string | null;
}

export type CarteraPaymentRole = 'invoice' | 'advance' | 'unmatched' | 'reversal';
export type AdvanceStatus = 'crossed' | 'partial' | 'pending' | 'unknown';

export interface CarteraPayment {
  id: string;
  number: string | null;
  paidOn: string;
  amount: number;
  clientKey: string | null;
  clientName: string | null;
  role: CarteraPaymentRole;
  /** La factura a la que se atribuye (sólo `invoice`). */
  invoiceNumber: string | null;
  advanceStatus: AdvanceStatus | null;
  /** FIFO: la factura abierta más antigua del cliente. Es una sugerencia. */
  suggestion: { invoiceId: string; docNumber: string; basis: 'fifo' } | null;
}

export interface CarteraCreditNote {
  number: string;
  invoiceNumber: string | null;
  amount: number;
  date: string;
  clientKey: string | null;
  clientName: string | null;
}

export interface CarteraClient {
  key: string;
  name: string;
  open: number;
  openInvoices: number;
  overdue: number;
  current: number;
  noTerm: number;
  /** Antigüedad media (días desde la factura) ponderada por saldo. */
  avgAgeDays: number | null;
  lastPaymentOn: string | null;
  lastPaymentAmount: number | null;
  /** Anticipos recibidos que todavía no se cruzan con facturas. */
  advancePending: number;
  advanceReceived: number;
  creditNotes: number;
  /** Saldo de la 1305 según los saldos por tercero de Siigo, si ya llegaron. */
  ledgerBalance: number | null;
  ledgerDiff: number | null;
}

export interface Compare {
  value: number;
  /** El mismo cálculo un mes atrás. null = no se puede calcular. */
  prev: number | null;
}

export interface CarteraModel {
  today: string;
  currency: string;
  kpis: {
    outstanding: Compare & { openInvoices: number };
    overdue: Compare & { pct: number; prevPct: number | null; invoices: number };
    collectedMonth: Compare;
    dso: { value: number | null; prev: number | null };
  };
  aging: Array<{
    key: CarteraBucketKey;
    label: string;
    amount: number;
    count: number;
    /** Por cliente (los 4 mayores y «Otros»), para apilar. */
    byClient: Array<{ key: string; name: string; amount: number }>;
  }>;
  stackClients: Array<{ key: string; name: string }>;
  clients: CarteraClient[];
  invoices: CarteraInvoice[];
  payments: CarteraPayment[];
  creditNotes: CarteraCreditNote[];
  monthly: Array<{ month: string; invoiced: number; collected: number }>;
  projection: {
    overdue: number;
    overdueCount: number;
    weeks: Array<{ from: string; to: string; amount: number; count: number }>;
    later: number;
    noTerm: number;
    noTermCount: number;
  };
  /** Facturado = por cobrar + cruzado/abonado + notas crédito. */
  reconciliation: {
    invoiced: number;
    open: number;
    settled: number;
    creditNotes: number;
    cashApplied: number;
  };
  advances: {
    count: number;
    received: number;
    pending: number;
    crossed: number;
    unknownStatus: number;
  };
  unmatched: { count: number; amount: number };
  ledgerCheck: { period: string; ledger: number; invoices: number; diff: number } | null;
  noTermInvoices: number;
  termBasis: { siigo: number; plazo_cliente: number; plazo_supuesto: number; sin_plazo: number };
  otherCurrencies: Array<{ currency: string; open: number; count: number }>;
}

// ---------------------------------------------------------------------------
// Fechas (días de calendario; Bogotá ya viene resuelta en `today`)
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;
const dn = (day: string) => Math.round(Date.parse(`${day.slice(0, 10)}T00:00:00Z`) / DAY_MS);
const fromDn = (n: number) => new Date(n * DAY_MS).toISOString().slice(0, 10);
const addDays = (day: string, n: number) => fromDn(dn(day) + n);
const diffDays = (from: string, to: string) => dn(to) - dn(from);
const monthOf = (day: string) => day.slice(0, 7);

function addMonths(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const idx = y * 12 + (m - 1) + n;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`;
}

/** El lunes de la semana de un día. */
function mondayOf(day: string): string {
  const dow = new Date(dn(day) * DAY_MS).getUTCDay(); // 0 = domingo
  return addDays(day, -((dow + 6) % 7));
}

const MONEY_EPS = 0.005;

export function docKey(raw: string | null | undefined): string {
  return (raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function nameKey(raw: string | null | undefined): string {
  return (raw ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

// ---------------------------------------------------------------------------
// Vencimiento
// ---------------------------------------------------------------------------

export function resolveDue(
  inv: { issuedOn: string; dueOn: string | null; clientKey: string },
  opts: { termDays?: Record<string, number>; defaultTermDays?: number | null },
): { dueOn: string | null; basis: DueBasis } {
  // Un plazo de verdad: vence DESPUÉS de expedirse. «Vence el mismo día» (o
  // antes) es lo que Siigo guarda cuando nadie escribió plazo.
  if (inv.dueOn && inv.dueOn > inv.issuedOn) return { dueOn: inv.dueOn, basis: 'siigo' };
  const client = opts.termDays?.[inv.clientKey];
  if (client && client > 0) return { dueOn: addDays(inv.issuedOn, client), basis: 'plazo_cliente' };
  const assumed = opts.defaultTermDays;
  if (assumed && assumed > 0)
    return { dueOn: addDays(inv.issuedOn, assumed), basis: 'plazo_supuesto' };
  return { dueOn: null, basis: 'sin_plazo' };
}

export function bucketOf(daysOverdue: number | null): CarteraBucketKey {
  if (daysOverdue === null) return 'no_term';
  if (daysOverdue <= 0) return 'current';
  if (daysOverdue <= 30) return 'd1_30';
  if (daysOverdue <= 60) return 'd31_60';
  if (daysOverdue <= 90) return 'd61_90';
  return 'd90_plus';
}

function weightedAge(items: Array<{ balance: number; ageDays: number }>): number | null {
  let w = 0;
  let acc = 0;
  for (const i of items) {
    if (i.balance <= 0 || i.ageDays < 0) continue;
    w += i.balance;
    acc += i.balance * i.ageDays;
  }
  return w > 0 ? Math.round(acc / w) : null;
}

function sum<T>(items: T[], f: (t: T) => number): number {
  let s = 0;
  for (const i of items) s += f(i);
  return s;
}

// ---------------------------------------------------------------------------
// La construcción
// ---------------------------------------------------------------------------

export function buildCartera(input: CarteraInput): CarteraModel {
  const today = input.today;
  const currency = input.currency ?? pickCurrency(input.invoices);
  const inCur = input.invoices.filter((i) => i.currency === currency);

  const otherMap = new Map<string, { open: number; count: number }>();
  for (const i of input.invoices) {
    if (i.currency === currency || i.balance <= MONEY_EPS) continue;
    const o = otherMap.get(i.currency) ?? { open: 0, count: 0 };
    o.open += i.balance;
    o.count += 1;
    otherMap.set(i.currency, o);
  }

  // --- facturas abiertas con su vencimiento -------------------------------
  const termBasis = { siigo: 0, plazo_cliente: 0, plazo_supuesto: 0, sin_plazo: 0 };
  const open: CarteraInvoice[] = [];
  for (const i of inCur) {
    if (i.balance <= MONEY_EPS) continue;
    const due = resolveDue(i, { termDays: input.termDays, defaultTermDays: input.defaultTermDays });
    termBasis[due.basis] += 1;
    const daysOverdue = due.dueOn ? diffDays(due.dueOn, today) : null;
    open.push({
      id: i.id,
      kind: i.kind,
      docNumber: i.docNumber,
      clientKey: i.clientKey,
      clientName: i.clientName,
      issuedOn: i.issuedOn,
      dueOn: due.dueOn,
      dueBasis: due.basis,
      daysOverdue,
      ageDays: diffDays(i.issuedOn, today),
      total: i.total,
      balance: i.balance,
      bucket: bucketOf(daysOverdue),
      einvoice: i.einvoice ?? null,
      url: i.url ?? null,
    });
  }
  open.sort((a, b) => b.balance - a.balance);

  const outstanding = sum(open, (i) => i.balance);
  const overdueInvoices = open.filter((i) => i.bucket !== 'current' && i.bucket !== 'no_term');
  const overdue = sum(overdueInvoices, (i) => i.balance);

  // --- recibos: a qué factura fue cada uno ---------------------------------
  const byNumber = new Map<string, CarteraInvoiceIn>();
  for (const i of inCur) byNumber.set(docKey(i.docNumber), i);
  const advanceKeys = new Set((input.advanceReceipts ?? []).map(docKey).filter(Boolean));
  const crossed = { ...(input.ledger?.advanceCrossedByClient ?? {}) };
  const ledgerKnown = input.ledger?.advanceCrossedByClient !== undefined;

  const fifoByClient = new Map<string, CarteraInvoice[]>();
  for (const i of [...open].sort((a, b) =>
    (a.dueOn ?? a.issuedOn).localeCompare(b.dueOn ?? b.issuedOn),
  )) {
    const list = fifoByClient.get(i.clientKey) ?? [];
    list.push(i);
    fifoByClient.set(i.clientKey, list);
  }

  const paymentsIn = input.payments
    .filter((p) => p.currency === currency)
    .sort((a, b) => a.paidOn.localeCompare(b.paidOn));
  const payments: CarteraPayment[] = [];
  const advanceLeft = new Map<string, number>(); // lo ya cruzado que falta repartir, por cliente
  const pendingOf = new Map<string, number>(); // lo que falta cruzar de cada anticipo
  for (const [k, v] of Object.entries(crossed)) advanceLeft.set(k, v);

  for (const p of paymentsIn) {
    const num = docKey(p.invoiceNumber);
    const own = docKey(p.reference);
    let role: CarteraPaymentRole;
    let invoiceNumber: string | null = null;
    if (p.kind === 'reversal') role = 'reversal';
    else if (num && byNumber.has(num)) {
      role = 'invoice';
      invoiceNumber = byNumber.get(num)?.docNumber ?? p.invoiceNumber;
    } else if (num && (advanceKeys.has(num) || num === own)) role = 'advance';
    else if (!num && own && advanceKeys.has(own)) role = 'advance';
    else role = 'unmatched';

    let advanceStatus: AdvanceStatus | null = null;
    if (role === 'advance') {
      if (!ledgerKnown || !p.clientKey) advanceStatus = 'unknown';
      else {
        // Los cruces se reparten por orden de fecha: lo cruzado cubre primero
        // los anticipos más viejos. Es una lectura, no un dato de Siigo.
        const left = advanceLeft.get(p.clientKey) ?? 0;
        const used = Math.min(left, p.amount);
        advanceLeft.set(p.clientKey, left - used);
        pendingOf.set(p.id, p.amount - used);
        advanceStatus = used >= p.amount - 0.5 ? 'crossed' : used > 0.5 ? 'partial' : 'pending';
      }
    }

    let suggestion: CarteraPayment['suggestion'] = null;
    if (role === 'unmatched' && p.clientKey) {
      const first = fifoByClient.get(p.clientKey)?.[0];
      if (first) suggestion = { invoiceId: first.id, docNumber: first.docNumber, basis: 'fifo' };
    }

    payments.push({
      id: p.id,
      number: p.reference,
      paidOn: p.paidOn,
      amount: p.kind === 'reversal' ? -p.amount : p.amount,
      clientKey: p.clientKey,
      clientName: p.clientName,
      role,
      invoiceNumber,
      advanceStatus,
      suggestion,
    });
  }
  payments.sort((a, b) => b.paidOn.localeCompare(a.paidOn));

  const advancePayments = payments.filter((p) => p.role === 'advance');
  const advances = {
    count: advancePayments.length,
    received: sum(advancePayments, (p) => p.amount),
    pending: sum(advancePayments, (p) => pendingOf.get(p.id) ?? 0),
    crossed: sum(
      advancePayments.filter((p) => p.advanceStatus === 'crossed'),
      (p) => p.amount,
    ),
    unknownStatus: advancePayments.filter((p) => p.advanceStatus === 'unknown').length,
  };
  const unmatchedList = payments.filter((p) => p.role === 'unmatched');

  // --- notas crédito -------------------------------------------------------
  const creditNotes: CarteraCreditNote[] = (input.creditNotes ?? [])
    .map((n) => ({
      number: n.number,
      invoiceNumber: n.invoiceNumber,
      amount: n.amount,
      date: n.date,
      clientKey: n.clientKey,
      clientName: n.clientName,
    }))
    .sort((a, b) => b.date.localeCompare(a.date));

  // --- clientes ------------------------------------------------------------
  const clientMap = new Map<string, CarteraClient>();
  const ensure = (key: string, name: string): CarteraClient => {
    let c = clientMap.get(key);
    if (!c) {
      c = {
        key,
        name,
        open: 0,
        openInvoices: 0,
        overdue: 0,
        current: 0,
        noTerm: 0,
        avgAgeDays: null,
        lastPaymentOn: null,
        lastPaymentAmount: null,
        advancePending: 0,
        advanceReceived: 0,
        creditNotes: 0,
        ledgerBalance: null,
        ledgerDiff: null,
      };
      clientMap.set(key, c);
    }
    return c;
  };
  const agesByClient = new Map<string, Array<{ balance: number; ageDays: number }>>();
  for (const i of open) {
    const c = ensure(i.clientKey, i.clientName);
    c.open += i.balance;
    c.openInvoices += 1;
    if (i.bucket === 'current') c.current += i.balance;
    else if (i.bucket === 'no_term') c.noTerm += i.balance;
    else c.overdue += i.balance;
    const ages = agesByClient.get(i.clientKey) ?? [];
    ages.push({ balance: i.balance, ageDays: i.ageDays });
    agesByClient.set(i.clientKey, ages);
  }
  for (const [k, ages] of agesByClient) {
    const c = clientMap.get(k);
    if (c) c.avgAgeDays = weightedAge(ages);
  }
  for (const p of payments) {
    if (!p.clientKey) continue;
    const c = ensure(p.clientKey, p.clientName ?? p.clientKey);
    if (p.role !== 'reversal' && (!c.lastPaymentOn || p.paidOn > c.lastPaymentOn)) {
      c.lastPaymentOn = p.paidOn;
      c.lastPaymentAmount = p.amount;
    }
    if (p.role === 'advance') {
      c.advanceReceived += p.amount;
      c.advancePending += pendingOf.get(p.id) ?? 0;
    }
  }
  for (const n of creditNotes) {
    if (!n.clientKey) continue;
    ensure(n.clientKey, n.clientName ?? n.clientKey).creditNotes += n.amount;
  }
  const ledger = input.ledger;
  if (ledger?.balance1305ByClient) {
    for (const c of clientMap.values()) {
      const l = ledger.balance1305ByClient[c.key];
      if (l === undefined) continue;
      c.ledgerBalance = l;
      c.ledgerDiff = Math.round((c.open - l) * 100) / 100;
    }
  }
  const clients = [...clientMap.values()].sort(
    (a, b) => b.open - a.open || b.advanceReceived - a.advanceReceived,
  );

  // --- antigüedad, apilada por cliente ------------------------------------
  const stackClients = clients
    .filter((c) => c.open > 0)
    .slice(0, 4)
    .map((c) => ({ key: c.key, name: c.name }));
  const stackKeys = new Set(stackClients.map((c) => c.key));
  const aging = BUCKET_ORDER.map((key) => {
    const rows = open.filter((i) => i.bucket === key);
    const byClient = new Map<string, number>();
    for (const r of rows) {
      const k = stackKeys.has(r.clientKey) ? r.clientKey : '__otros';
      byClient.set(k, (byClient.get(k) ?? 0) + r.balance);
    }
    return {
      key,
      label: BUCKET_LABEL[key],
      amount: sum(rows, (r) => r.balance),
      count: rows.length,
      byClient: [...byClient.entries()].map(([k, amount]) => ({
        key: k,
        name: k === '__otros' ? 'Otros clientes' : (clientMap.get(k)?.name ?? k),
        amount,
      })),
    };
  });

  // --- por mes: facturado vs cobrado --------------------------------------
  const thisMonth = monthOf(today);
  const months: string[] = [];
  for (let n = -11; n <= 0; n++) months.push(addMonths(thisMonth, n));
  const monthly = months.map((month) => ({
    month,
    invoiced: sum(
      inCur.filter((i) => monthOf(i.issuedOn) === month),
      (i) => i.total,
    ),
    collected: sum(
      payments.filter((p) => monthOf(p.paidOn) === month),
      (p) => p.amount,
    ),
  }));

  // --- proyección por semana ------------------------------------------------
  const weekStart = mondayOf(today);
  const weeks = Array.from({ length: 8 }, (_, w) => ({
    from: addDays(weekStart, w * 7),
    to: addDays(weekStart, w * 7 + 6),
    amount: 0,
    count: 0,
  }));
  let later = 0;
  let noTerm = 0;
  let noTermCount = 0;
  for (const i of open) {
    if (i.bucket === 'no_term') {
      noTerm += i.balance;
      noTermCount += 1;
    } else if (i.dueOn && i.dueOn > today) {
      const w = weeks.find((x) => i.dueOn !== null && i.dueOn >= x.from && i.dueOn <= x.to);
      if (w) {
        w.amount += i.balance;
        w.count += 1;
      } else later += i.balance;
    }
  }

  // --- conciliación --------------------------------------------------------
  const invoicedAll = sum(inCur, (i) => i.total);
  const openAll = sum(inCur, (i) => Math.max(i.balance, 0));
  const matchedNotes = sum(
    creditNotes.filter((n) => !n.invoiceNumber || byNumber.has(docKey(n.invoiceNumber))),
    (n) => n.amount,
  );
  const settled = Math.max(invoicedAll - openAll, 0);

  // --- comparaciones contra el mes anterior --------------------------------
  const d30 = addDays(today, -30);
  const invoiced30 = sum(
    inCur.filter((i) => i.issuedOn > d30 && i.issuedOn <= today),
    (i) => i.total,
  );
  const reductions30 = ledger?.receivableCredits?.length
    ? sum(
        ledger.receivableCredits.filter((c) => c.date > d30 && c.date <= today),
        (c) => c.amount,
      )
    : sum(
        payments.filter((p) => p.paidOn > d30 && p.paidOn <= today),
        (p) => p.amount,
      ) +
      sum(
        creditNotes.filter((n) => n.date > d30 && n.date <= today),
        (n) => n.amount,
      );
  const prevOutstanding = Math.max(outstanding - invoiced30 + reductions30, 0);

  const prevOverdue = sum(
    open.filter((i) => {
      if (i.issuedOn > d30 || !i.dueOn || i.bucket === 'no_term') return false;
      return diffDays(i.dueOn, d30) > 0;
    }),
    (i) => i.balance,
  );

  const day = Number(today.slice(8, 10));
  const prevMonth = addMonths(thisMonth, -1);
  const collectedMonth = sum(
    payments.filter((p) => monthOf(p.paidOn) === thisMonth),
    (p) => p.amount,
  );
  const collectedPrev = sum(
    payments.filter((p) => monthOf(p.paidOn) === prevMonth && Number(p.paidOn.slice(8, 10)) <= day),
    (p) => p.amount,
  );

  const win = (from: string, to: string) =>
    sum(
      inCur.filter((i) => i.issuedOn > from && i.issuedOn <= to),
      (i) => i.total,
    );
  const sales90 = win(addDays(today, -90), today);
  const sales90Prev = win(addDays(today, -120), d30);
  const dsoNow = sales90 > 0 ? Math.round((outstanding / sales90) * 90) : null;
  const dsoPrev = sales90Prev > 0 ? Math.round((prevOutstanding / sales90Prev) * 90) : null;

  // --- cuadre contra la contabilidad ---------------------------------------
  let ledgerCheck: CarteraModel['ledgerCheck'] = null;
  if (ledger?.balance1305ByClient && ledger.balancePeriod) {
    const ledgerTotal = sum(Object.values(ledger.balance1305ByClient), (v) => v);
    ledgerCheck = {
      period: ledger.balancePeriod,
      ledger: ledgerTotal,
      invoices: outstanding,
      diff: Math.round((outstanding - ledgerTotal) * 100) / 100,
    };
  }

  return {
    today,
    currency,
    kpis: {
      outstanding: { value: outstanding, prev: prevOutstanding, openInvoices: open.length },
      overdue: {
        value: overdue,
        prev: prevOverdue,
        pct: outstanding > 0 ? overdue / outstanding : 0,
        prevPct: prevOutstanding > 0 ? prevOverdue / prevOutstanding : null,
        invoices: overdueInvoices.length,
      },
      collectedMonth: { value: collectedMonth, prev: collectedPrev },
      dso: { value: dsoNow, prev: dsoPrev },
    },
    aging,
    stackClients,
    clients,
    invoices: open,
    payments,
    creditNotes,
    monthly,
    projection: {
      overdue,
      overdueCount: overdueInvoices.length,
      weeks,
      later,
      noTerm,
      noTermCount,
    },
    reconciliation: {
      invoiced: invoicedAll,
      open: openAll,
      settled,
      creditNotes: Math.min(matchedNotes, settled),
      cashApplied: Math.max(settled - matchedNotes, 0),
    },
    advances,
    unmatched: { count: unmatchedList.length, amount: sum(unmatchedList, (p) => p.amount) },
    ledgerCheck,
    noTermInvoices: termBasis.sin_plazo,
    termBasis,
    otherCurrencies: [...otherMap.entries()].map(([c, v]) => ({ currency: c, ...v })),
  };
}

/** La moneda con más saldo abierto (COP si no hay nada). */
function pickCurrency(invoices: CarteraInvoiceIn[]): string {
  const by = new Map<string, number>();
  for (const i of invoices) by.set(i.currency, (by.get(i.currency) ?? 0) + Math.max(i.balance, 0));
  let best = 'COP';
  let max = -1;
  for (const [c, v] of by) if (v > max) [best, max] = [c, v];
  return best;
}

export { nameKey as carteraNameKey };
