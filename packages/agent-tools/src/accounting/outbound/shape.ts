import { createHash } from 'node:crypto';
import { InvalidNitError, formatNit, nitDv, normalizeNit, parseNit } from '../../clients/shape';

/**
 * LO QUE LAS APPS LE ESCRIBEN AL PROGRAMA CONTABLE, EN FORMA COMÚN (0232). Puro.
 *
 * Cuatro cosas salen de la bandeja «Por enviar a Siigo»: la factura (que ya
 * existía, camino de Ventas), el CLIENTE (tercero), el RECIBO DE CAJA y la NOTA
 * CRÉDITO. Aquí viven las formas que NO dependen del programa y la lógica que
 * se puede probar sin red: el NIT con su dígito de verificación, el cruce de un
 * pago contra las facturas abiertas (la más vieja primero), los problemas que
 * una persona debe ver antes de aprobar. Cada programa (providers/outbound.ts)
 * traduce estas formas a su JSON.
 */

export const OUTBOX_KINDS = ['invoice', 'receipt', 'credit_note', 'customer'] as const;
export type OutboxKind = (typeof OUTBOX_KINDS)[number];

export const OUTBOX_KIND_LABEL: Record<OutboxKind, string> = {
  invoice: 'Factura',
  receipt: 'Recibo de caja',
  credit_note: 'Nota crédito',
  customer: 'Cliente',
};

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ---------------------------------------------------------------------------
// Cliente (tercero)
// ---------------------------------------------------------------------------

export interface CityRef {
  name: string;
  /** Código DANE del departamento (2 dígitos). */
  stateCode: string;
  /** Código DANE del municipio (5 dígitos). */
  cityCode: string;
}

const CITIES: Array<[string, string, string]> = [
  ['Bogotá', '11', '11001'],
  ['Medellín', '05', '05001'],
  ['Cali', '76', '76001'],
  ['Barranquilla', '08', '08001'],
  ['Cartagena', '13', '13001'],
  ['Bucaramanga', '68', '68001'],
  ['Cúcuta', '54', '54001'],
  ['Pereira', '66', '66001'],
  ['Manizales', '17', '17001'],
  ['Santa Marta', '47', '47001'],
  ['Ibagué', '73', '73001'],
  ['Villavicencio', '50', '50001'],
  ['Pasto', '52', '52001'],
  ['Montería', '23', '23001'],
  ['Neiva', '41', '41001'],
  ['Armenia', '63', '63001'],
  ['Popayán', '19', '19001'],
  ['Valledupar', '20', '20001'],
  ['Sincelejo', '70', '70001'],
  ['Tunja', '15', '15001'],
  ['Riohacha', '44', '44001'],
  ['Florencia', '18', '18001'],
  ['Yopal', '85', '85001'],
  ['Quibdó', '27', '27001'],
  ['Rionegro', '05', '05615'],
  ['Envigado', '05', '05266'],
  ['Itagüí', '05', '05360'],
  ['Bello', '05', '05088'],
  ['Sabaneta', '05', '05631'],
  ['Apartadó', '05', '05045'],
  ['Soacha', '25', '25754'],
  ['Chía', '25', '25175'],
  ['Cota', '25', '25214'],
  ['Funza', '25', '25286'],
  ['Mosquera', '25', '25473'],
  ['Girardot', '25', '25307'],
  ['Palmira', '76', '76520'],
  ['Buenaventura', '76', '76109'],
  ['Tuluá', '76', '76834'],
  ['Cartago', '76', '76147'],
  ['Barrancabermeja', '68', '68081'],
  ['Floridablanca', '68', '68276'],
  ['Dosquebradas', '66', '66170'],
  ['Leticia', '91', '91001'],
  ['San Andrés', '88', '88001'],
  ['Arauca', '81', '81001'],
  ['Mocoa', '86', '86001'],
  ['Mitú', '97', '97001'],
  ['Puerto Carreño', '99', '99001'],
  ['Inírida', '94', '94001'],
  ['San José del Guaviare', '95', '95001'],
];

function plain(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * La ciudad por nombre («Bogotá», «bogota d.c.», «Medellín, Antioquia») o por
 * código DANE de 5 dígitos. `null` si no se reconoce: no se inventa un código.
 */
export function findCity(raw: string | null | undefined): CityRef | null {
  const text = (raw ?? '').trim();
  if (!text) return null;
  if (/^\d{5}$/.test(text)) {
    const hit = CITIES.find((c) => c[2] === text);
    return { name: hit?.[0] ?? text, stateCode: text.slice(0, 2), cityCode: text };
  }
  const key = plain(text.split(',')[0] ?? text).replace(/ d c$/, '');
  const hit = CITIES.find((c) => plain(c[0]) === key);
  return hit ? { name: hit[0], stateCode: hit[1], cityCode: hit[2] } : null;
}

export type CustomerPersonType = 'Company' | 'Person';

export interface CustomerPayload {
  /** Sólo dígitos, sin dígito de verificación. */
  taxId: string;
  /** Dígito de verificación calculado (NIT); `null` en una cédula. */
  dv: string | null;
  /** Código DIAN del tipo de documento: 31 = NIT, 13 = cédula. */
  idType: '31' | '13';
  personType: CustomerPersonType;
  name: string;
  email: string | null;
  phone: string | null;
  address: string | null;
  city: CityRef | null;
  /** Responsable de IVA (régimen común). */
  vatResponsible: boolean;
}

export interface CustomerInput {
  taxId: string;
  name: string;
  email?: string;
  phone?: string;
  address?: string;
  city?: string;
  personType?: 'auto' | 'company' | 'person';
  regime?: 'responsable_iva' | 'no_responsable';
}

/**
 * El NIT como lo entiende Siigo: sin puntos ni DV, con el DV recalculado. Si la
 * persona escribió un DV que no cuadra, se avisa (un dígito cambiado crea un
 * tercero repetido que después no empareja con nada).
 */
export function resolveTaxId(raw: string): { digits: string; dv: string; formatted: string } | { error: string } {
  try {
    const p = parseNit(raw);
    return { digits: p.digits, dv: String(p.dv), formatted: p.formatted };
  } catch (err) {
    if (err instanceof InvalidNitError) return { error: err.message };
    return { error: 'No se pudo leer el NIT.' };
  }
}

/** Un NIT de empresa empieza por 8 o 9 (o 7 en convenios); lo demás es una cédula. */
export function guessPersonType(digits: string): CustomerPersonType {
  return /^[89]\d{8,9}$/.test(digits) || (digits.length === 9 && digits.startsWith('7')) ? 'Company' : 'Person';
}

export function buildCustomerPayload(input: CustomerInput): { payload: CustomerPayload | null; problems: string[] } {
  const problems: string[] = [];
  const nit = resolveTaxId(input.taxId);
  if ('error' in nit) return { payload: null, problems: [nit.error] };
  const personType: CustomerPersonType =
    input.personType === 'company' ? 'Company' : input.personType === 'person' ? 'Person' : guessPersonType(nit.digits);
  const name = input.name.replace(/\s+/g, ' ').trim();
  if (!name) problems.push('Falta el nombre o razón social del cliente.');
  const email = input.email?.trim().toLowerCase() || null;
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) problems.push(`El correo «${email}» no parece válido.`);
  const city = input.city?.trim() ? findCity(input.city) : null;
  if (input.city?.trim() && !city)
    problems.push(`No reconozco la ciudad «${input.city.trim()}»: escribe el municipio (Bogotá, Medellín…) o su código DANE de 5 dígitos.`);
  const phone = input.phone?.replace(/[^\d+]/g, '') || null;
  return {
    payload: {
      taxId: nit.digits,
      dv: personType === 'Company' ? nit.dv : null,
      idType: personType === 'Company' ? '31' : '13',
      personType,
      name,
      email,
      phone,
      address: input.address?.trim() || null,
      city,
      vatResponsible: input.regime === 'responsable_iva',
    },
    problems,
  };
}

/** Lo que Siigo exige para crear un tercero y todavía falta (se ve antes de aprobar). */
export function customerProblems(p: CustomerPayload): string[] {
  const out: string[] = [];
  if (!p.name) out.push('Falta el nombre o razón social.');
  if (!p.address) out.push('Siigo exige la dirección del cliente.');
  if (!p.city) out.push('Siigo exige la ciudad (con su código DANE): elige una.');
  if (!p.phone) out.push('Siigo exige un teléfono del cliente.');
  if (!p.email) out.push('Siigo exige al menos un contacto con correo.');
  return out;
}

/** «Marcos Castillo» → [«Marcos», «Castillo»]: lo que pide Siigo para una persona natural. */
export function splitPersonName(name: string): string[] {
  const w = name.split(/\s+/).filter(Boolean);
  if (w.length <= 1) return w;
  if (w.length === 2) return w;
  if (w.length === 3) return [w[0] as string, w.slice(1).join(' ')];
  return [w.slice(0, 2).join(' '), w.slice(2).join(' ')];
}

export function describeCustomer(p: CustomerPayload): string {
  return `${p.name || 'Cliente'} · ${p.idType === '31' ? 'NIT' : 'CC'} ${formatNit(p.taxId)}${p.dv ? `-${p.dv}` : ''}${p.city ? ` · ${p.city.name}` : ''}`;
}

// ---------------------------------------------------------------------------
// Recibo de caja: cruzar un pago contra facturas abiertas
// ---------------------------------------------------------------------------

export interface OpenInvoice {
  number: string;
  externalId: string;
  balance: number;
  dueOn: string | null;
  issuedOn: string | null;
}

export interface ReceiptApplication {
  invoiceNumber: string;
  invoiceExternalId: string | null;
  invoiceDate: string | null;
  amount: number;
}

export interface ReceiptPayload {
  customerTaxId: string;
  customerName: string;
  date: string;
  amount: number;
  applications: ReceiptApplication[];
  /** Cuenta de banco / caja de Cortex donde entró el dinero, si se sabe. */
  bankAccount: string | null;
  reference: string | null;
}

/**
 * Cruza `amount` contra las facturas con saldo, la que vence primero primero
 * (y, a igual vencimiento, la más antigua, y por número para ser estable). Un
 * peso no se aplica dos veces ni más allá del saldo: lo que sobra queda en
 * `unapplied` (un anticipo que una persona decide qué hacer).
 */
export function allocatePayment(
  amount: number,
  invoices: readonly OpenInvoice[],
): { applications: ReceiptApplication[]; unapplied: number } {
  let left = round2(amount);
  const ordered = invoices
    .filter((i) => i.balance > 0.005)
    .sort(
      (a, b) =>
        (a.dueOn ?? '9999').localeCompare(b.dueOn ?? '9999') ||
        (a.issuedOn ?? '9999').localeCompare(b.issuedOn ?? '9999') ||
        a.number.localeCompare(b.number, 'es', { numeric: true }),
    );
  const applications: ReceiptApplication[] = [];
  for (const inv of ordered) {
    if (left <= 0.005) break;
    const part = round2(Math.min(left, inv.balance));
    applications.push({
      invoiceNumber: inv.number,
      invoiceExternalId: inv.externalId || null,
      invoiceDate: inv.issuedOn,
      amount: part,
    });
    left = round2(left - part);
  }
  return { applications, unapplied: Math.max(left, 0) };
}

export function receiptProblems(p: ReceiptPayload): string[] {
  const out: string[] = [];
  if (!p.customerTaxId) out.push('Falta el NIT del cliente.');
  if (!(p.amount > 0)) out.push('El valor del pago es cero.');
  if (!p.applications.length)
    out.push('No hay facturas con saldo del cliente para cruzar: revisa el NIT o indica las facturas a mano.');
  const applied = round2(p.applications.reduce((s, a) => s + a.amount, 0));
  if (p.applications.length && Math.abs(applied - p.amount) > 0.01)
    out.push(
      `El pago (${p.amount.toLocaleString('es-CO')}) y lo cruzado contra facturas (${applied.toLocaleString('es-CO')}) no coinciden: ajusta los valores o deja el resto como anticipo en Siigo.`,
    );
  for (const a of p.applications) if (!(a.amount > 0)) out.push(`La factura ${a.invoiceNumber} no tiene valor a cruzar.`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.date)) out.push('La fecha del recibo no es válida.');
  return out;
}

// ---------------------------------------------------------------------------
// Nota crédito
// ---------------------------------------------------------------------------

/** Motivos de devolución de la DIAN que acepta Siigo (`reason`). */
export const CREDIT_NOTE_REASONS = [1, 2, 3, 4, 6, 7] as const;
export type CreditNoteReason = (typeof CREDIT_NOTE_REASONS)[number];
export const CREDIT_NOTE_REASON_LABEL: Record<CreditNoteReason, string> = {
  1: 'Devolución parcial de bienes o no aceptación parcial del servicio',
  2: 'Anulación de la factura electrónica',
  3: 'Rebaja o descuento parcial o total',
  4: 'Ajuste de precio',
  6: 'Descuento comercial por pronto pago',
  7: 'Descuento comercial por volumen de ventas',
};

export interface CreditNoteItem {
  description: string;
  productCode: string | null;
  quantity: number;
  /** Pesos, antes de IVA. */
  unitPrice: number;
  taxRate: 'iva_19' | 'iva_5' | 'iva_0' | 'excluido';
}

export interface CreditNotePayload {
  /** La factura que afecta («FV-1-68»). */
  invoiceNumber: string;
  invoiceExternalId: string | null;
  customerTaxId: string | null;
  date: string;
  reason: CreditNoteReason;
  observations: string;
  /** `total`: copia las líneas de la factura (anular o devolver todo); `items`: las de abajo. */
  mode: 'total' | 'items';
  items: CreditNoteItem[];
}

export function creditNoteProblems(p: CreditNotePayload): string[] {
  const out: string[] = [];
  if (!p.invoiceNumber) out.push('Falta el número de la factura que afecta la nota crédito.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.date)) out.push('La fecha de la nota no es válida.');
  if (!CREDIT_NOTE_REASONS.includes(p.reason)) out.push('El motivo de la nota crédito no es uno de la DIAN.');
  if (p.mode === 'items') {
    if (!p.items.length) out.push('La nota crédito por ítems necesita al menos una línea.');
    p.items.forEach((it, i) => {
      if (!it.productCode) out.push(`La línea ${i + 1} no tiene código de producto de Siigo.`);
      if (!(it.quantity > 0)) out.push(`La línea ${i + 1} no tiene cantidad.`);
      if (!(it.unitPrice >= 0)) out.push(`La línea ${i + 1} no tiene precio.`);
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Idempotencia
// ---------------------------------------------------------------------------

/**
 * La llave de (empresa, borrador): la misma siempre, para que reintentar tras
 * una red cortada no cree un segundo recibo ni una segunda nota (Siigo la honra
 * en `Idempotency-Key`; alfanumérica, ≤ 30).
 */
export function outboxIdempotencyKey(organizationId: string, kind: OutboxKind, draftId: string): string {
  const hex = createHash('sha256').update(`outbox:${organizationId}:${kind}:${draftId}`).digest('hex');
  return `CXO${hex.slice(0, 27)}`;
}

/** Un NIT sin DV comparado con otro que pudo traerlo pegado («9001234567»). */
export function sameNit(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = normalizeNit(a);
  const y = normalizeNit(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [long, short] = x.length > y.length ? [x, y] : [y, x];
  return long.length === short.length + 1 && long.startsWith(short) && nitDv(short) === Number(long.slice(-1));
}

/** El NIT sin DV de lo que la persona escribió («900.123.456-7» → «900123456»); vacío si no se lee. */
export function formatNitDigits(raw: string): string {
  if (!raw.trim()) return '';
  const nit = resolveTaxId(raw);
  return 'error' in nit ? '' : nit.digits;
}
