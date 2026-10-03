import { addDays, bogotaToday, daysBetween } from '../commitments/shape';

/**
 * LA FICHA Y LA LISTA DE CLIENTES, EN CIFRAS: puro, sin base de datos.
 *
 * Lo que la lista (/clients) y la ficha (/clients/[id]) dicen de la plata y del
 * contacto de cada cliente sale de AQUÍ, a partir de filas ya leídas. El
 * lector (hub-read.ts) y el escaparate de desarrollo le pasan filas; los
 * tests también. Así la lista, la ficha, la fuente `cortex.clientes` y el
 * chat no pueden decir dos cosas distintas del mismo cliente.
 *
 * LAS REGLAS DE LA PLATA SON LAS DE LA CARTERA (payments/store.ts
 * `receivables`), repetidas a propósito para leer TODOS los clientes en una
 * pasada:
 *
 *   - Una factura cuenta si es de un programa contable (con su saldo, tal
 *     cual, sin restarle pagos) o si es un documento CONFIRMADO como factura
 *     por cobrar (con lo cobrado = pagos que cuentan atados a ESA factura).
 *   - Si el mismo número existe como documento y en el programa contable,
 *     cuenta UNA vez: la del documento.
 *   - Las cifras en pesos son SÓLO pesos. Lo que esté en otra moneda se marca
 *     (`otherCurrencies`) y no se suma.
 *
 * Cada sección puede faltar (`undefined` = no se pudo leer) y entonces sus
 * columnas quedan en null: «sin dato», nunca un cero inventado.
 */

const COP = 'COP';

// ---------------------------------------------------------------------------
// Las filas que entran
// ---------------------------------------------------------------------------

export interface AccountingInvoiceIn {
  id: string;
  client_id: string | null;
  doc_number: string;
  currency: string;
  total: number | string;
  balance: number | string;
  issued_on: string;
  due_on: string | null;
  annulled: boolean;
  source_system?: string | null;
  public_url?: string | null;
}

export interface DocumentInvoiceIn {
  id: string;
  client_id: string | null;
  doc_number: string | null;
  currency: string | null;
  total_amount: number | string | null;
  issued_on: string | null;
  due_on: string | null;
}

export interface PaymentIn {
  id: string;
  client_id: string | null;
  extraction_id: string | null;
  invoice_number: string | null;
  amount: number | string;
  currency: string;
  paid_on: string;
  kind?: string | null;
}

export interface LedgerIn {
  id: string;
  client_id: string | null;
  kind: string;
  direction: string;
  status: string;
  amount: number | string;
  currency: string;
  date: string;
  due_date: string | null;
  settled_at: string | null;
  doc_number: string | null;
}

/** Un momento de contacto con el cliente (correo, reunión, WhatsApp, nota, cobro enviado). */
export interface ContactIn {
  client_id: string;
  at: string;
  kind: ContactKind;
}

export type ContactKind = 'email' | 'meeting' | 'whatsapp' | 'note' | 'action';

export const CONTACT_KIND_LABEL: Record<ContactKind, string> = {
  email: 'correo',
  meeting: 'reunión',
  whatsapp: 'WhatsApp',
  note: 'nota',
  action: 'correo de cobro',
};

export interface CommitmentIn {
  client_id: string | null;
  due_on: string;
  state: string;
  title: string;
  amount_cop?: number | null;
}

export interface MoneyInputs {
  accountingInvoices?: AccountingInvoiceIn[];
  documentInvoices?: DocumentInvoiceIn[];
  /** Sólo los que cuentan (reportados o confirmados). */
  payments?: PaymentIn[];
  /** Sólo lo que cuenta (ni duplicado, ni anulado, ni en disputa). */
  ledger?: LedgerIn[];
}

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

export function toNum(value: number | string | null | undefined): number | null {
  if (value == null || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** «FV-2-22», «fv 2 22» y «FV2-22» son el mismo número (igual que payments). */
export function docKey(raw: string | null | undefined): string {
  return (raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

const day = (value: string | null | undefined) => (value ? value.slice(0, 10) : null);

// ---------------------------------------------------------------------------
// Las facturas de un cliente, abiertas o no
// ---------------------------------------------------------------------------

export interface ClientInvoice {
  id: string;
  source: 'document' | 'accounting';
  system: string | null;
  docNumber: string | null;
  currency: string;
  total: number;
  /** Lo que falta por cobrar. 0 = pagada. */
  balance: number;
  issuedOn: string | null;
  dueOn: string | null;
  /** Días de mora (>0) o null si no está vencida. */
  daysOverdue: number | null;
  href: string | null;
}

/** Todas las facturas de cada cliente, con las reglas de la cartera. */
export function invoicesByClient(inputs: MoneyInputs, today: string): Map<string, ClientInvoice[]> {
  const out = new Map<string, ClientInvoice[]>();
  const push = (clientId: string, inv: ClientInvoice) => {
    const list = out.get(clientId);
    if (list) list.push(inv);
    else out.set(clientId, [inv]);
  };

  const paidByExtraction = new Map<string, number>();
  for (const p of inputs.payments ?? []) {
    if (!p.extraction_id) continue;
    const amount = toNum(p.amount) ?? 0;
    const signed = p.kind === 'reversal' ? -amount : amount;
    const k = `${p.extraction_id}\u0000${p.currency}`;
    paidByExtraction.set(k, (paidByExtraction.get(k) ?? 0) + signed);
  }

  const documentNumbers = new Set<string>();
  for (const d of inputs.documentInvoices ?? []) {
    const key = docKey(d.doc_number);
    if (key) documentNumbers.add(key);
    const total = toNum(d.total_amount);
    if (!d.client_id || total == null || !d.currency) continue;
    const paid = paidByExtraction.get(`${d.id}\u0000${d.currency}`) ?? 0;
    const balance = Math.max(0, total - paid);
    const late = d.due_on ? daysBetween(d.due_on, today) : null;
    push(d.client_id, {
      id: d.id,
      source: 'document',
      system: null,
      docNumber: d.doc_number,
      currency: d.currency,
      total,
      balance: balance > 0.005 ? balance : 0,
      issuedOn: d.issued_on,
      dueOn: d.due_on,
      daysOverdue: balance > 0.005 && late != null && late > 0 ? late : null,
      href: null,
    });
  }

  for (const a of inputs.accountingInvoices ?? []) {
    if (!a.client_id || a.annulled) continue;
    // El mismo número como documento confirmado: cuenta una vez, la del documento.
    if (documentNumbers.has(docKey(a.doc_number))) continue;
    const total = toNum(a.total) ?? 0;
    const balance = Math.max(0, toNum(a.balance) ?? 0);
    const late = a.due_on ? daysBetween(a.due_on, today) : null;
    push(a.client_id, {
      id: a.id,
      source: 'accounting',
      system: a.source_system ?? null,
      docNumber: a.doc_number,
      currency: a.currency,
      total,
      balance: balance > 0.005 ? balance : 0,
      issuedOn: a.issued_on,
      dueOn: a.due_on,
      daysOverdue: balance > 0.005 && late != null && late > 0 ? late : null,
      href: a.public_url ?? null,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Cuánto se demora en pagar
// ---------------------------------------------------------------------------

export interface PaymentDays {
  /** Días promedio entre la emisión y el pago completo, redondeado. */
  average: number;
  /** Cuántas facturas pagadas lo respaldan. */
  sample: number;
}

/**
 * Días promedio de pago, del COMPORTAMIENTO: para cada factura ya pagada de la
 * que se sabe la fecha de emisión y cuándo entró la plata, los días entre una
 * y otra. La fecha de pago sale de lo que el libro y Pagos registraron: el
 * pago atado a la factura (por documento o por número), un ingreso del libro
 * con el mismo número, o la fecha en que el libro dio la factura por saldada.
 * Si hubo varios abonos, cuenta el último (cuando quedó pagada).
 *
 * Sin facturas así, no hay número: null («sin dato»), no un cero.
 */
export function paymentDaysOf(
  invoices: readonly ClientInvoice[],
  payments: readonly PaymentIn[],
  ledger: readonly LedgerIn[],
): PaymentDays | null {
  const paidOn = new Map<string, string>();
  const note = (key: string, when: string | null | undefined) => {
    const d = day(when);
    if (!key || !d) return;
    const prev = paidOn.get(key);
    if (!prev || d > prev) paidOn.set(key, d);
  };
  const byExtraction = new Map(
    invoices.filter((i) => i.source === 'document').map((i) => [i.id, i]),
  );
  for (const p of payments) {
    if (p.kind === 'reversal') continue;
    const inv = p.extraction_id ? byExtraction.get(p.extraction_id) : null;
    note(inv ? `id:${inv.id}` : `n:${docKey(p.invoice_number)}`, p.paid_on);
  }
  for (const m of ledger) {
    if (m.direction !== 'in') continue;
    if (m.kind === 'receivable' && m.status === 'settled')
      note(`n:${docKey(m.doc_number)}`, m.settled_at);
    if (m.kind === 'income' && m.status === 'settled') note(`n:${docKey(m.doc_number)}`, m.date);
  }

  const days: number[] = [];
  const seen = new Set<string>();
  for (const inv of invoices) {
    if (inv.balance > 0 || !inv.issuedOn) continue;
    const key = docKey(inv.docNumber);
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    const paid = paidOn.get(`id:${inv.id}`) ?? (key ? paidOn.get(`n:${key}`) : undefined);
    if (!paid) continue;
    days.push(Math.max(0, daysBetween(inv.issuedOn, paid)));
  }
  // Las facturas que el libro conoce y la cartera no (otra fuente): también cuentan.
  for (const m of ledger) {
    if (m.kind !== 'receivable' || m.status !== 'settled' || m.direction !== 'in') continue;
    const key = docKey(m.doc_number);
    if (!key || seen.has(key)) continue;
    const paid = paidOn.get(`n:${key}`);
    if (!paid) continue;
    seen.add(key);
    days.push(Math.max(0, daysBetween(m.date, paid)));
  }
  if (days.length === 0) return null;
  const average = Math.round(days.reduce((s, d) => s + d, 0) / days.length);
  return { average, sample: days.length };
}

// ---------------------------------------------------------------------------
// La plata de un cliente
// ---------------------------------------------------------------------------

export interface ClientMoney {
  /** Facturado en pesos en los últimos 12 meses (emitido). */
  invoiced12m: number;
  invoiced12mCount: number;
  /** Saldo por cobrar en pesos (todo lo abierto). */
  outstanding: number;
  openCount: number;
  /** De ese saldo, lo vencido. */
  overdue: number;
  overdueCount: number;
  /** La factura vencida más vieja, en días de mora. */
  maxDaysOverdue: number | null;
  /** El próximo vencimiento de una factura abierta (hoy o después). */
  nextDue: { on: string; amount: number; docNumber: string | null } | null;
  paymentDays: PaymentDays | null;
  /** Monedas distintas de pesos con saldo o facturación: se dicen, no se suman. */
  otherCurrencies: string[];
  /** Las facturas abiertas, la más vencida primero. */
  open: ClientInvoice[];
}

export function moneyOf(
  invoices: readonly ClientInvoice[],
  payments: readonly PaymentIn[],
  ledger: readonly LedgerIn[],
  today: string,
): ClientMoney {
  const since = addDays(today, -365);
  const others = new Set<string>();
  const money: ClientMoney = {
    invoiced12m: 0,
    invoiced12mCount: 0,
    outstanding: 0,
    openCount: 0,
    overdue: 0,
    overdueCount: 0,
    maxDaysOverdue: null,
    nextDue: null,
    paymentDays: paymentDaysOf(invoices, payments, ledger),
    otherCurrencies: [],
    open: [],
  };
  for (const inv of invoices) {
    if (inv.currency !== COP) {
      if (inv.balance > 0 || (inv.issuedOn && inv.issuedOn >= since)) others.add(inv.currency);
      continue;
    }
    if (inv.issuedOn && inv.issuedOn >= since && inv.issuedOn <= today) {
      money.invoiced12m += inv.total;
      money.invoiced12mCount += 1;
    }
    if (inv.balance <= 0) continue;
    money.outstanding += inv.balance;
    money.openCount += 1;
    money.open.push(inv);
    if (inv.daysOverdue != null) {
      money.overdue += inv.balance;
      money.overdueCount += 1;
      money.maxDaysOverdue = Math.max(money.maxDaysOverdue ?? 0, inv.daysOverdue);
    } else if (inv.dueOn && inv.dueOn >= today) {
      if (!money.nextDue || inv.dueOn < money.nextDue.on) {
        money.nextDue = { on: inv.dueOn, amount: inv.balance, docNumber: inv.docNumber };
      }
    }
  }
  money.open.sort(
    (a, b) =>
      (b.daysOverdue ?? -1) - (a.daysOverdue ?? -1) ||
      (a.dueOn ?? '9').localeCompare(b.dueOn ?? '9'),
  );
  money.otherCurrencies = [...others].sort();
  return money;
}

// ---------------------------------------------------------------------------
// La salud, en palabras
// ---------------------------------------------------------------------------

export type HealthTone = 'emerald' | 'amber' | 'rose' | 'neutral';

export interface ClientHealth {
  tone: HealthTone;
  /** Dos o tres palabras para el chip: «Al día», «Pagos atrasados». */
  label: string;
  /** Una frase con el porqué: «$4.200.000 vencidos hace 47 días». */
  reason: string;
}

/** Más de esto sin contacto y con plata pendiente: hay que llamar. */
export const QUIET_DAYS = 45;
/** Mora a partir de la cual el chip se pone rojo. */
export const LATE_DAYS = 60;

export function cop(amount: number): string {
  return `$${Math.round(amount).toLocaleString('es-CO')}`;
}

/**
 * Cómo está el cliente, dicho como lo diría alguien de cartera. Sin plata
 * leída (`money` null) sólo se habla de lo que sí se sabe.
 */
export function clientHealth(input: {
  status: string;
  money: Pick<ClientMoney, 'overdue' | 'maxDaysOverdue' | 'outstanding' | 'invoiced12m'> | null;
  lastContactAt: string | null;
  today: string;
}): ClientHealth {
  const { money, today } = input;
  const quiet = input.lastContactAt ? daysBetween(day(input.lastContactAt) as string, today) : null;
  if (input.status === 'blocked') {
    return {
      tone: 'rose',
      label: 'Bloqueado',
      reason: 'Está marcado para no hacerle más negocios.',
    };
  }
  if (money && money.overdue > 0) {
    const days = money.maxDaysOverdue ?? 0;
    const tone: HealthTone = days > LATE_DAYS ? 'rose' : 'amber';
    return {
      tone,
      label: days > LATE_DAYS ? 'Cartera muy vencida' : 'Pagos atrasados',
      reason: `${cop(money.overdue)} vencidos; la más vieja hace ${days} día${days === 1 ? '' : 's'}.`,
    };
  }
  if (money && money.outstanding > 0 && (quiet === null || quiet > QUIET_DAYS)) {
    return {
      tone: 'amber',
      label: 'Debe y está callado',
      reason:
        quiet === null
          ? `Debe ${cop(money.outstanding)} y no hay contacto registrado.`
          : `Debe ${cop(money.outstanding)} y el último contacto fue hace ${quiet} días.`,
    };
  }
  if ((!money || money.invoiced12m === 0) && (quiet === null || quiet > 90)) {
    return {
      tone: 'neutral',
      label: 'Sin movimiento',
      reason: money
        ? 'No hay facturas en 12 meses ni contacto reciente.'
        : 'No hay contacto reciente.',
    };
  }
  return {
    tone: 'emerald',
    label: 'Al día',
    reason:
      money && money.outstanding > 0
        ? `Debe ${cop(money.outstanding)}, nada vencido.`
        : 'No debe nada vencido.',
  };
}

// ---------------------------------------------------------------------------
// La lista
// ---------------------------------------------------------------------------

export interface ListClientIn {
  id: string;
  name: string;
  legal_name: string | null;
  tax_id: string | null;
  status: string;
  owner_user_id: string | null;
  owner_name?: string | null;
  tags?: string[] | null;
  source?: string | null;
  city?: string | null;
  updated_at: string;
}

export interface ClientListRow {
  id: string;
  name: string;
  legalName: string | null;
  taxId: string | null;
  status: string;
  ownerId: string | null;
  owner: string | null;
  tags: string[];
  source: string;
  city: string | null;
  /** null = no se pudo leer la plata. */
  invoiced12m: number | null;
  outstanding: number | null;
  overdue: number | null;
  maxDaysOverdue: number | null;
  paymentDays: number | null;
  paymentDaysSample: number;
  lastContactAt: string | null;
  lastContactKind: ContactKind | null;
  /** Días desde el último contacto; null si nunca o sin dato. */
  quietDays: number | null;
  /** Próximo vencimiento: de una factura abierta o de un vencimiento con fecha. */
  nextDueOn: string | null;
  nextDueWhat: string | null;
  health: ClientHealth;
  otherCurrencies: string[];
  /** Qué secciones no se pudieron leer, en palabras. */
  missing: string[];
}

export interface ListInputs extends MoneyInputs {
  contacts?: ContactIn[];
  commitments?: CommitmentIn[];
}

/** Una fila por cliente, con todo lo que la lista muestra. */
export function assembleClientRows(
  clients: readonly ListClientIn[],
  inputs: ListInputs,
  today: string = bogotaToday(),
): ClientListRow[] {
  const moneyRead =
    inputs.accountingInvoices !== undefined &&
    inputs.documentInvoices !== undefined &&
    inputs.payments !== undefined;
  const invoices = invoicesByClient(inputs, today);
  const paymentsBy = groupBy(inputs.payments ?? [], (p) => p.client_id);
  const ledgerBy = groupBy(inputs.ledger ?? [], (m) => m.client_id);

  const lastContact = new Map<string, ContactIn>();
  for (const c of inputs.contacts ?? []) {
    const prev = lastContact.get(c.client_id);
    if (!prev || c.at > prev.at) lastContact.set(c.client_id, c);
  }
  const nextCommitment = new Map<string, CommitmentIn>();
  for (const c of inputs.commitments ?? []) {
    if (!c.client_id || c.state === 'met' || c.state === 'dropped' || c.due_on < today) continue;
    const prev = nextCommitment.get(c.client_id);
    if (!prev || c.due_on < prev.due_on) nextCommitment.set(c.client_id, c);
  }

  const missing: string[] = [];
  if (!moneyRead) missing.push('facturas y pagos');
  if (inputs.contacts === undefined) missing.push('último contacto');
  if (inputs.commitments === undefined) missing.push('vencimientos');

  return clients.map((c) => {
    const money = moneyRead
      ? moneyOf(
          invoices.get(c.id) ?? [],
          paymentsBy.get(c.id) ?? [],
          ledgerBy.get(c.id) ?? [],
          today,
        )
      : null;
    const contact = lastContact.get(c.id) ?? null;
    const commitment = nextCommitment.get(c.id) ?? null;
    let nextDueOn: string | null = money?.nextDue?.on ?? null;
    let nextDueWhat: string | null = money?.nextDue
      ? `Factura ${money.nextDue.docNumber ?? ''} · ${cop(money.nextDue.amount)}`.replace('  ', ' ')
      : null;
    if (commitment && (!nextDueOn || commitment.due_on < nextDueOn)) {
      nextDueOn = commitment.due_on;
      nextDueWhat = commitment.title;
    }
    const lastContactAt = contact?.at ?? null;
    return {
      id: c.id,
      name: c.name,
      legalName: c.legal_name,
      taxId: c.tax_id,
      status: c.status,
      ownerId: c.owner_user_id,
      owner: c.owner_name ?? null,
      tags: c.tags ?? [],
      source: c.source ?? 'manual',
      city: c.city ?? null,
      invoiced12m: money ? money.invoiced12m : null,
      outstanding: money ? money.outstanding : null,
      overdue: money ? money.overdue : null,
      maxDaysOverdue: money?.maxDaysOverdue ?? null,
      paymentDays: money?.paymentDays?.average ?? null,
      paymentDaysSample: money?.paymentDays?.sample ?? 0,
      lastContactAt,
      lastContactKind: contact?.kind ?? null,
      quietDays: lastContactAt ? daysBetween(day(lastContactAt) as string, today) : null,
      nextDueOn,
      nextDueWhat,
      health: clientHealth({ status: c.status, money, lastContactAt, today }),
      otherCurrencies: money?.otherCurrencies ?? [],
      missing,
    };
  });
}

function groupBy<T>(rows: readonly T[], key: (row: T) => string | null): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of rows) {
    const k = key(row);
    if (!k) continue;
    const list = out.get(k);
    if (list) list.push(row);
    else out.set(k, [row]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// La línea de tiempo
// ---------------------------------------------------------------------------

export type TimelineKind =
  | 'invoice'
  | 'payment'
  | 'email'
  | 'action'
  | 'meeting'
  | 'commitment'
  | 'case'
  | 'document'
  | 'whatsapp'
  | 'note';

export const TIMELINE_KIND_LABEL: Record<TimelineKind, string> = {
  invoice: 'Facturas',
  payment: 'Pagos',
  email: 'Correos',
  action: 'Cobros',
  meeting: 'Reuniones',
  commitment: 'Compromisos',
  case: 'Casos',
  document: 'Documentos',
  whatsapp: 'WhatsApp',
  note: 'Notas',
};

export interface TimelineItem {
  id: string;
  kind: TimelineKind;
  /** Fecha o instante ISO; ordena la línea. */
  at: string;
  title: string;
  detail?: string | null;
  /** Quién lo hizo o de dónde vino, si se sabe. */
  by?: string | null;
  href?: string | null;
  tone?: 'neutral' | 'emerald' | 'amber' | 'rose' | 'primary';
}

/** Lo más reciente primero; lo de fecha futura (un vencimiento) también entra, arriba. */
export function sortTimeline(items: TimelineItem[]): TimelineItem[] {
  return [...items].sort((a, b) => b.at.localeCompare(a.at));
}
