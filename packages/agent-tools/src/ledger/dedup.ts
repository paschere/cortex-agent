import { addDays, normalizeText, sameTaxId } from './shape';
import type { LedgerDirection, LedgerKind, LedgerSourceKind, LedgerStatus } from './types';

/**
 * UN MOVIMIENTO REAL, CONTADO UNA SOLA VEZ (migración 0172, regla 2).
 *
 * El mismo pago llega por dos caminos casi siempre: el recibo de Siigo y el
 * abono del extracto; la factura de Siigo y el PDF de esa factura; lo que
 * alguien dijo en el chat y la salida del banco de ese día. Sumar las dos es
 * el error más caro que puede cometer un libro, porque el resultado sigue
 * pareciendo un número plausible. Este archivo decide, sin base de datos:
 *
 *   QUÉ FILAS SON EL MISMO HECHO.
 *     · Las que comparten `link_key` lo son sin discusión: dos reportes que el
 *       módulo de pagos (0098) ya enlazó al mismo pago, o dos facturas con el
 *       mismo número del mismo lado.
 *     · Sin llave común sólo se enlaza lo inequívoco (`findLikelyTwin`): ya
 *       pasó, mismo sentido, misma moneda, MISMO valor exacto, a tres días o
 *       menos, de fuentes de clase distinta, con la contraparte coincidiendo
 *       por NIT o por nombre, y un solo candidato. Si hay dos candidatos no se
 *       elige ninguno: dos clientes pagando lo mismo el mismo día existen.
 *       Dos filas con llaves de pago DISTINTAS nunca se enlazan: el módulo de
 *       pagos ya decidió que son dos pagos.
 *
 *   CUÁL MANDA. Para plata que ya se movió, el banco, porque es donde de verdad
 *   pasó (y trae la cuenta); luego el programa contable, el pago reportado, el
 *   documento, la hoja, lo dicho a mano y el chat. Para facturas, el documento
 *   confirmado por una persona y luego el programa contable — la misma regla
 *   que la cartera ya usa (0165). Una fila anulada no manda sobre una viva.
 *
 * Nada se borra: la que sobra apunta a la que manda (`duplicate_of`) y deja de
 * contar. Deshacer un enlace es poner `duplicate_of` en null.
 */

export const CASH_RANK: Record<LedgerSourceKind, number> = {
  bank: 0,
  accounting: 1,
  payment: 2,
  document: 3,
  sheet: 4,
  manual: 5,
  chat: 6,
};

export const INVOICE_RANK: Record<LedgerSourceKind, number> = {
  document: 0,
  accounting: 1,
  sheet: 2,
  manual: 3,
  chat: 4,
  payment: 5,
  bank: 6,
};

/** Días de diferencia que aún pueden ser el mismo movimiento (banco vs. recibo). */
export const TWIN_WINDOW_DAYS = 3;

export interface DedupRow {
  id: string;
  kind: LedgerKind;
  direction: LedgerDirection;
  status: LedgerStatus;
  amount: number;
  currency: string;
  date: string;
  counterpartyName: string | null;
  counterpartyTaxId: string | null;
  description: string;
  sourceKind: LedgerSourceKind;
  /**
   * El sistema de la fuente. Un 'document' CON sistema ('correo · …',
   * 'documento · …') lo anotó el agente leyendo un papel, sin la confirmación
   * campo por campo de una factura leída (0076): pesa como algo dicho a mano.
   */
  sourceSystem?: string | null;
  linkKey: string | null;
  duplicateOf: string | null;
  createdAt: string;
}

function rankOf(row: Pick<DedupRow, 'kind' | 'sourceKind' | 'status' | 'sourceSystem'>): number {
  const table = row.kind === 'receivable' || row.kind === 'payable' ? INVOICE_RANK : CASH_RANK;
  const kind = row.sourceKind === 'document' && row.sourceSystem ? 'manual' : row.sourceKind;
  return (row.status === 'cancelled' ? 100 : 0) + table[kind];
}

/** La fila que manda en un grupo del mismo hecho. */
export function pickPrimary<
  T extends Pick<DedupRow, 'id' | 'kind' | 'sourceKind' | 'status' | 'createdAt' | 'sourceSystem'>,
>(group: T[]): T | null {
  if (!group.length) return null;
  return (
    [...group].sort(
      (a, b) =>
        rankOf(a) - rankOf(b) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
    )[0] ?? null
  );
}

/**
 * Qué hay que cambiar para que un grupo quede con una sola fila que cuenta:
 * la que manda sin `duplicate_of`, las demás apuntándole. Sólo devuelve lo que
 * cambia, para no reescribir filas que ya están bien.
 */
export function planGroup(
  group: Array<
    Pick<
      DedupRow,
      'id' | 'kind' | 'sourceKind' | 'sourceSystem' | 'status' | 'createdAt' | 'duplicateOf'
    >
  >,
): Array<{ id: string; duplicateOf: string | null }> {
  const primary = pickPrimary(group);
  if (!primary) return [];
  const out: Array<{ id: string; duplicateOf: string | null }> = [];
  for (const row of group) {
    const want = row.id === primary.id ? null : primary.id;
    if ((row.duplicateOf ?? null) !== want) out.push({ id: row.id, duplicateOf: want });
  }
  return out;
}

const NAME_NOISE = new Set([
  'sas',
  's',
  'a',
  'sa',
  'ltda',
  'ltd',
  'inc',
  'cia',
  'y',
  'de',
  'del',
  'la',
  'el',
  'los',
  'las',
  'e',
  'u',
  'co',
  'colombia',
  'pago',
  'pagos',
  'transferencia',
  'pse',
]);

function significantTokens(name: string | null | undefined): string[] {
  return normalizeText(name)
    .split(' ')
    .filter((t) => t.length >= 3 && !NAME_NOISE.has(t));
}

/**
 * ¿La contraparte de una fila aparece en la otra? Todas las palabras con peso
 * del nombre más corto tienen que estar en el texto de la otra (su contraparte
 * más su descripción), y al menos una de cuatro letras o más: «Transportes X»
 * aparece en «PAGO PSE TRANSPORTES X SAS».
 */
export function counterpartyMatches(
  a: Pick<DedupRow, 'counterpartyName' | 'counterpartyTaxId' | 'description'>,
  b: Pick<DedupRow, 'counterpartyName' | 'counterpartyTaxId' | 'description'>,
): boolean {
  if (sameTaxId(a.counterpartyTaxId, b.counterpartyTaxId)) return true;
  const check = (
    named: Pick<DedupRow, 'counterpartyName'>,
    other: Pick<DedupRow, 'counterpartyName' | 'description'>,
  ) => {
    const tokens = significantTokens(named.counterpartyName);
    if (!tokens.some((t) => t.length >= 4)) return false;
    const haystack = new Set(
      normalizeText(`${other.counterpartyName ?? ''} ${other.description}`).split(' '),
    );
    return tokens.every((t) => haystack.has(t));
  };
  return check(a, b) || check(b, a);
}

/**
 * El gemelo inequívoco de una fila recién llegada, o null. Ver la cabecera:
 * ningún candidato o más de uno es «no sé», y «no sé» no enlaza.
 */
export function findLikelyTwin<T extends DedupRow>(candidate: DedupRow, pool: T[]): T | null {
  if (candidate.status !== 'settled') return null;
  if (candidate.kind !== 'income' && candidate.kind !== 'expense') return null;
  const from = addDays(candidate.date, -TWIN_WINDOW_DAYS);
  const to = addDays(candidate.date, TWIN_WINDOW_DAYS);
  const matches = pool.filter(
    (row) =>
      row.id !== candidate.id &&
      row.status === 'settled' &&
      (row.kind === 'income' || row.kind === 'expense') &&
      row.direction === candidate.direction &&
      row.currency === candidate.currency &&
      Math.abs(row.amount - candidate.amount) < 0.005 &&
      row.date >= from &&
      row.date <= to &&
      row.sourceKind !== candidate.sourceKind &&
      !row.duplicateOf &&
      !(row.linkKey && candidate.linkKey && row.linkKey !== candidate.linkKey) &&
      !(row.linkKey && candidate.linkKey && row.linkKey === candidate.linkKey) &&
      counterpartyMatches(row, candidate),
  );
  return matches.length === 1 ? (matches[0] as T) : null;
}
