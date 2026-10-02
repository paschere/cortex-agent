import { createHash } from 'node:crypto';
import {
  type CategorySource,
  LEDGER_CATEGORIES,
  type LedgerDirection,
  type LedgerKind,
  type LedgerMovement,
  type LedgerSourceKind,
  type LedgerStatus,
} from './types';

/**
 * EL VOCABULARIO DEL LIBRO DE PLATA, SIN BASE DE DATOS.
 *
 * Todo lo que aquí hay es puro: cómo se normaliza un nombre o un NIT, cómo se
 * arma la llave de un hecho real que llega por dos fuentes, cómo se pasa de
 * una fila de `ledger_movements` (0172) al contrato de `types.ts` y de vuelta.
 * Lo que toca la base vive en store.ts; lo que decide qué fila manda, en
 * dedup.ts; lo que pone la categoría, en categorize.ts.
 */

export const LEDGER_SOURCE_KINDS: readonly LedgerSourceKind[] = [
  'accounting',
  'bank',
  'payment',
  'document',
  'sheet',
  'manual',
  'chat',
];

export const LEDGER_KINDS: readonly LedgerKind[] = [
  'income',
  'expense',
  'receivable',
  'payable',
  'transfer',
];

/** Cómo se dice cada categoría a un dueño. */
export const CATEGORY_LABEL: Record<string, string> = {
  ventas: 'Ventas',
  otros_ingresos: 'Otros ingresos',
  nomina: 'Nómina y seguridad social',
  arriendo: 'Arriendo',
  servicios_publicos: 'Servicios públicos',
  transporte: 'Transporte y fletes',
  proveedores: 'Proveedores',
  impuestos: 'Impuestos',
  bancos_y_financieros: 'Bancos y financieros',
  software: 'Software y suscripciones',
  mercadeo: 'Mercadeo y publicidad',
  mantenimiento: 'Mantenimiento',
  honorarios: 'Honorarios',
  otros_gastos: 'Otros gastos',
};

export const KIND_LABEL: Record<LedgerKind, string> = {
  income: 'Ingreso',
  expense: 'Gasto',
  receivable: 'Por cobrar',
  payable: 'Por pagar',
  transfer: 'Entre cuentas',
};

export const STATUS_LABEL: Record<LedgerStatus, string> = {
  expected: 'Esperado',
  settled: 'Pasó',
  cancelled: 'Anulado',
};

export const SOURCE_KIND_LABEL: Record<LedgerSourceKind, string> = {
  accounting: 'Programa contable',
  bank: 'Extracto del banco',
  payment: 'Pago reportado',
  document: 'Documento',
  sheet: 'Hoja o tabla',
  manual: 'A mano',
  chat: 'Chat',
};

export function categoryLabel(category: string | null | undefined): string {
  if (!category) return 'Sin categoría';
  return CATEGORY_LABEL[category] ?? category.replace(/_/g, ' ');
}

/** Una categoría válida: de la lista o inventada con la misma forma. */
export function isCategoryKey(value: string | null | undefined): value is string {
  return typeof value === 'string' && /^[a-z][a-z0-9_]{1,39}$/.test(value);
}

/** «Servicios Públicos» → 'servicios_publicos'; null si no se puede. */
export function toCategoryKey(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const folded = normalizeText(raw).replace(/\s+/g, '_');
  if ((LEDGER_CATEGORIES as readonly string[]).includes(folded)) return folded;
  for (const [key, label] of Object.entries(CATEGORY_LABEL)) {
    if (normalizeText(label).replace(/\s+/g, '_') === folded) return key;
  }
  return isCategoryKey(folded) ? folded : null;
}

/**
 * Minúsculas, sin tildes, sólo letras y números separados por un espacio. La
 * eñe se conserva: «año» y «ano» no son la misma palabra.
 */
export function normalizeText(raw: string | null | undefined): string {
  return (raw ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/n\u0303/g, 'ñ')
    .replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Sólo dígitos; null si no alcanza para ser un NIT o una cédula. */
export function normalizeTaxId(raw: string | null | undefined): string | null {
  const digits = (raw ?? '').replace(/\D/g, '');
  return digits.length >= 3 && digits.length <= 20 ? digits : null;
}

/** Mismo NIT, con o sin el dígito de verificación al final. */
export function sameTaxId(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = normalizeTaxId(a);
  const y = normalizeTaxId(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length < y.length ? [x, y] : [y, x];
  return long.length === short.length + 1 && long.startsWith(short) && short.length >= 6;
}

/** El nombre de una cuenta como llave: «Bancolombia  Corriente» = «bancolombia corriente». */
export function accountNameKey(raw: string | null | undefined): string {
  return normalizeText(raw).slice(0, 80).trim();
}

/** «FV-2-22», «fv 2 22» y «FV2-22» son el mismo número (igual que payments/store). */
export function docKey(raw: string | null | undefined): string {
  return (raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Las clases de movimiento que pueden tener un gemelo en otra fuente: plata que ya pasó. */
export const TWIN_KINDS = ['income', 'expense'] as const;

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function isIsoDate(value: string | null | undefined): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/** El día de Bogotá de un instante; una fecha AAAA-MM-DD pasa tal cual. */
export function dayOf(value: string | null | undefined): string | null {
  if (!value) return null;
  if (isIsoDate(value)) return value;
  const t = Date.parse(value);
  if (Number.isNaN(t)) return null;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Bogota',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(t));
}

export function addDays(day: string, days: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function monthOf(day: string): string {
  return day.slice(0, 7);
}

/** Una huella corta y estable: la referencia que se deriva cuando la fuente no trae una. */
export function refHash(parts: Array<string | number | null | undefined>): string {
  return createHash('sha256')
    .update(parts.map((p) => (p == null ? '' : String(p))).join('\u0001'))
    .digest('hex')
    .slice(0, 32);
}

/**
 * La llave del HECHO de una factura, compartida entre fuentes. Las de venta son
 * de la empresa y su número es único; las de compra se numeran por proveedor,
 * así que su llave lleva el NIT (o el nombre) del proveedor, y sin ninguno de
 * los dos no hay llave: dos «Factura 1» de dos proveedores no son la misma.
 */
export function invoiceLinkKey(input: {
  direction: LedgerDirection;
  docNumber?: string | null;
  counterpartyTaxId?: string | null;
  counterpartyName?: string | null;
}): string | null {
  const number = docKey(input.docNumber);
  if (!number) return null;
  if (input.direction === 'in') return `invoice:in:${number}`.slice(0, 200);
  const who =
    normalizeTaxId(input.counterpartyTaxId)?.slice(0, 9) ??
    (normalizeText(input.counterpartyName).replace(/\s+/g, '') || null);
  if (!who) return null;
  return `invoice:out:${who.slice(0, 60)}:${number}`.slice(0, 200);
}

export function paymentLinkKey(paymentId: string | null | undefined): string | null {
  return paymentId ? `payment:${paymentId}` : null;
}

export function moneyText(n: number, currency: string): string {
  try {
    return new Intl.NumberFormat('es-CO', {
      style: 'currency',
      currency,
      maximumFractionDigits: currency === 'COP' ? 0 : 2,
    }).format(n);
  } catch {
    return `${currency} ${n.toFixed(2)}`;
  }
}

// ---------------------------------------------------------------------------
// Lo que una fuente entrega, y la fila
// ---------------------------------------------------------------------------

/**
 * Un movimiento tal como lo entrega un adaptador, antes de existir: sin id, y
 * con los campos que sólo viven en la base (llave del hecho, número de
 * factura, exclusión). La categoría es opcional: si la fuente la sabe (una
 * persona la dijo en el chat), llega con `categorySource: 'person'`.
 */
export interface MovementDraft extends Omit<LedgerMovement, 'id' | 'category' | 'categorySource'> {
  category?: string | null;
  categorySource?: CategorySource | null;
  docNumber?: string | null;
  linkKey?: string | null;
  excludedReason?: 'disputed' | null;
  recordedBy?: string | null;
  /**
   * Qué hacer si la fila ya existe. 'replace' (por defecto): los hechos de
   * este borrador mandan. 'status': sólo se actualizan estado, exclusión y
   * llave del hecho — para una fuente que vuelve a hablar de un movimiento que
   * otra lectura más rica ya escribió (el reporte de pago de un abono que el
   * extracto ya trajo con su contraparte y su cuenta).
   */
  merge?: 'replace' | 'status';
}

export interface MovementRow {
  id: string;
  direction: LedgerDirection;
  kind: LedgerKind;
  status: LedgerStatus;
  amount: number | string;
  currency: string;
  date: string;
  due_date: string | null;
  settled_at: string | null;
  outstanding: number | string | null;
  counterparty_name: string | null;
  counterparty_tax_id: string | null;
  category: string | null;
  category_source: CategorySource | null;
  category_rule_id: string | null;
  description: string;
  doc_number: string | null;
  account_id: string | null;
  source_kind: LedgerSourceKind;
  source_system: string;
  source_ref: string;
  link_key: string | null;
  duplicate_of: string | null;
  excluded_reason: 'disputed' | null;
  recorded_by: string | null;
  /**
   * En una factura por pagar: la salida del banco que la saldó (0173,
   * payables.ts), y el saldo que tenía antes, para deshacerlo intacto.
   */
  settled_by?: string | null;
  settled_by_outstanding?: number | string | null;
  created_at: string;
  updated_at: string;
}

export const MOVEMENT_COLUMNS =
  'id, direction, kind, status, amount, currency, date, due_date, settled_at, outstanding, counterparty_name, counterparty_tax_id, category, category_source, category_rule_id, description, doc_number, account_id, source_kind, source_system, source_ref, link_key, duplicate_of, excluded_reason, recorded_by, settled_by, settled_by_outstanding, created_at, updated_at';

export function num(value: number | string | null | undefined): number | null {
  if (value == null || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** La fila, en el contrato. */
export function rowToMovement(row: MovementRow): LedgerMovement {
  return {
    id: row.id,
    direction: row.direction,
    kind: row.kind,
    status: row.status,
    amount: num(row.amount) ?? 0,
    currency: row.currency,
    date: row.date,
    dueDate: row.due_date,
    settledAt: row.settled_at,
    outstanding: num(row.outstanding),
    counterpartyName: row.counterparty_name,
    counterpartyTaxId: row.counterparty_tax_id,
    category: row.category,
    categorySource: row.category_source,
    description: row.description,
    accountId: row.account_id,
    source: {
      kind: row.source_kind,
      system: row.source_system || null,
      ref: row.source_ref,
    },
  };
}

/** ¿Esta fila entra en las sumas? Ni duplicada, ni anulada, ni en disputa. */
export function isCounted(
  row: Pick<MovementRow, 'duplicate_of' | 'status' | 'excluded_reason'>,
): boolean {
  return !row.duplicate_of && row.status !== 'cancelled' && !row.excluded_reason;
}

export class LedgerDraftError extends Error {}

/**
 * Lo que la base exigiría, dicho antes y en español. Devuelve el borrador
 * limpio (recortes, NIT en dígitos, fechas) o lanza `LedgerDraftError`.
 */
export function cleanDraft(draft: MovementDraft): MovementDraft {
  const fail = (why: string): never => {
    throw new LedgerDraftError(why);
  };
  if (!Number.isFinite(draft.amount) || draft.amount < 0)
    fail('El valor tiene que ser un número positivo.');
  if (!/^[A-Z]{3}$/.test(draft.currency ?? ''))
    fail('La moneda tiene que ser de tres letras (COP, USD…).');
  if (!isIsoDate(draft.date)) fail('La fecha tiene que ser AAAA-MM-DD.');
  if (draft.dueDate != null && !isIsoDate(draft.dueDate))
    fail('El vencimiento tiene que ser AAAA-MM-DD.');
  if (draft.settledAt != null && !isIsoDate(draft.settledAt))
    fail('La fecha de pago tiene que ser AAAA-MM-DD.');
  if (!draft.source?.ref) fail('Falta la referencia de la fuente.');
  const description = (draft.description ?? '').replace(/\s+/g, ' ').trim().slice(0, 500);
  const isInvoice = draft.kind === 'receivable' || draft.kind === 'payable';
  const category = draft.category && isCategoryKey(draft.category) ? draft.category : null;
  return {
    ...draft,
    amount: round2(draft.amount),
    description: description || KIND_LABEL[draft.kind],
    counterpartyName: draft.counterpartyName?.replace(/\s+/g, ' ').trim().slice(0, 200) || null,
    counterpartyTaxId: normalizeTaxId(draft.counterpartyTaxId),
    outstanding:
      isInvoice && draft.outstanding != null && Number.isFinite(draft.outstanding)
        ? round2(Math.max(0, draft.outstanding))
        : null,
    docNumber: draft.docNumber?.trim().slice(0, 120) || null,
    category,
    categorySource: category ? (draft.categorySource ?? 'person') : null,
    source: {
      kind: draft.source.kind,
      system: (draft.source.system ?? '').slice(0, 80),
      ref: draft.source.ref.slice(0, 200),
    },
  };
}

/** Los hechos de una fila, sin categoría (la categoría se escribe aparte). */
export function draftFacts(draft: MovementDraft): Record<string, unknown> {
  return {
    direction: draft.direction,
    kind: draft.kind,
    status: draft.status,
    amount: draft.amount,
    currency: draft.currency,
    date: draft.date,
    due_date: draft.dueDate ?? null,
    settled_at: draft.settledAt ?? null,
    outstanding: draft.outstanding ?? null,
    counterparty_name: draft.counterpartyName ?? null,
    counterparty_tax_id: draft.counterpartyTaxId ?? null,
    description: draft.description,
    doc_number: draft.docNumber ?? null,
    account_id: draft.accountId ?? null,
    source_kind: draft.source.kind,
    source_system: draft.source.system ?? '',
    source_ref: draft.source.ref,
    link_key: draft.linkKey ?? null,
    excluded_reason: draft.excludedReason ?? null,
  };
}

/** La llave única de la fila, como texto. */
export function sourceKey(source: {
  kind: string;
  system?: string | null;
  ref: string;
}): string {
  return `${source.kind}\u0001${source.system ?? ''}\u0001${source.ref}`;
}
