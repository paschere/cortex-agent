import type { SupabaseClient } from '@supabase/supabase-js';
import { daysBetween, makeKeyResolver, nameMatches, normalizeTaxId } from './forecast-shared';
import { MOVEMENT_COLUMNS, type MovementRow, isCounted, num } from './shape';

/**
 * LA FACTURA DEL PROVEEDOR QUE EL BANCO YA PAGÓ (migración 0173).
 *
 * Una factura por pagar llega abierta (de un PDF confirmado, del programa
 * contable, del chat) y el pago llega por otro lado: una salida del extracto.
 * Sin atarlas, la factura se queda «por pagar» en la proyección de caja para
 * siempre y la caja sale más apretada de lo que está. Aquí se atan.
 *
 * CUÁNDO UNA SALIDA DEL BANCO PAGA UNA FACTURA (`matchPayables`, puro):
 *
 *   - La factura: por pagar, abierta, que cuenta (ni duplicada, ni anulada, ni
 *     en disputa) y sin saldar todavía.
 *   - La salida: un gasto liquidado que vino del EXTRACTO (el banco es donde
 *     la plata de verdad salió), que cuenta, y que no saldó ya otra factura.
 *   - Misma moneda; el valor de la salida a ±1% de lo pendiente de la factura;
 *     la salida el día de la emisión o después (y no más de un año después).
 *   - La misma contraparte: el NIT, o el nombre (que cada palabra del nombre
 *     de la factura esté en la contraparte o en la descripción de la salida:
 *     «PAGO PROV INMOBILIARIA LOS ANDES» paga a «Inmobiliaria Los Andes
 *     S.A.S.»), o el NIT escrito en la descripción.
 *   - Si una factura tiene varias salidas posibles, la más cercana a su
 *     vencimiento; cada salida paga a lo sumo una factura. Las facturas se
 *     reparten por vencimiento, la más vieja primero.
 *
 * QUÉ SE ESCRIBE (`settlePayablesFromBank`): la factura queda `settled`, con
 * la fecha de la salida, pendiente 0, `settled_by` = la salida y
 * `settled_by_outstanding` = lo que tenía pendiente. Idempotente: sólo toca
 * facturas abiertas sin saldar (y lo comprueba en el mismo UPDATE), así que
 * correrlo dos veces no mueve nada.
 *
 * REVERSIBLE: en cada corrida, una factura saldada cuya salida ya no cuenta
 * (anulada, duplicada de otra, en disputa, o desaparecida) vuelve a abrirse
 * con su pendiente de antes. Una fuente que vuelve a traer la factura abierta
 * no lo deshace (store.ts › factChanges): manda el banco.
 *
 * Lo corren `syncLedger` (cada corrida) y `ingestBankStatement` (al importar
 * un extracto). Toda lectura revisa `error`; el `db` llega con alcance de
 * empresa.
 */

export const PAYABLE_MATCH_TOLERANCE = 0.01;
/** Una salida más de esto después de la emisión ya no paga esa factura. */
export const PAYABLE_MATCH_MAX_DAYS = 365;
const SCAN = 3000;

export interface PayableMatch {
  payableId: string;
  debitId: string;
  /** Día de la salida: cuándo quedó saldada. */
  date: string;
  /** Lo que la factura tenía pendiente antes de saldarla. */
  outstanding: number;
}

function openAmount(row: MovementRow): number {
  return num(row.outstanding) ?? num(row.amount) ?? 0;
}

function isOpenPayable(row: MovementRow): boolean {
  return (
    row.kind === 'payable' &&
    row.direction === 'out' &&
    row.status === 'expected' &&
    !row.settled_by &&
    isCounted(row)
  );
}

function isBankDebit(row: MovementRow): boolean {
  return (
    row.kind === 'expense' &&
    row.direction === 'out' &&
    row.status === 'settled' &&
    row.source_kind === 'bank' &&
    isCounted(row)
  );
}

/**
 * Qué salida del banco paga qué factura. Puro y determinista. `used` son las
 * salidas que ya saldaron otra factura.
 */
export function matchPayables(
  payables: readonly MovementRow[],
  debits: readonly MovementRow[],
  used: ReadonlySet<string> = new Set(),
): PayableMatch[] {
  const resolve = makeKeyResolver(
    [...payables, ...debits].map((r) => ({
      name: r.counterparty_name,
      taxId: r.counterparty_tax_id,
    })),
  );
  const free = debits
    .filter((d) => isBankDebit(d) && !used.has(d.id))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : 1));
  const taken = new Set<string>();
  const out: PayableMatch[] = [];
  const open = payables.filter(isOpenPayable).sort((a, b) => {
    const da = a.due_date ?? a.date;
    const db = b.due_date ?? b.date;
    return da < db ? -1 : da > db ? 1 : a.id < b.id ? -1 : 1;
  });
  for (const p of open) {
    const pending = openAmount(p);
    if (!(pending > 0)) continue;
    const pKey = resolve(p.counterparty_name, p.counterparty_tax_id);
    const pNit = normalizeTaxId(p.counterparty_tax_id);
    const due = p.due_date ?? p.date;
    let best: MovementRow | null = null;
    for (const d of free) {
      if (taken.has(d.id) || d.currency !== p.currency) continue;
      const amount = num(d.amount) ?? 0;
      if (Math.abs(amount - pending) > pending * PAYABLE_MATCH_TOLERANCE) continue;
      const lag = daysBetween(p.date, d.date);
      if (lag < 0 || lag > PAYABLE_MATCH_MAX_DAYS) continue;
      const text = `${d.counterparty_name ?? ''} ${d.description}`;
      const dKey = resolve(d.counterparty_name, d.counterparty_tax_id);
      const sameParty =
        (pKey !== null && dKey !== null && pKey === dKey) ||
        (p.counterparty_name ? nameMatches(p.counterparty_name, text) : false) ||
        (pNit !== '' && text.replace(/\D/g, ' ').split(' ').includes(pNit));
      if (!sameParty) continue;
      if (!best || Math.abs(daysBetween(due, d.date)) < Math.abs(daysBetween(due, best.date)))
        best = d;
    }
    if (!best) continue;
    taken.add(best.id);
    out.push({ payableId: p.id, debitId: best.id, date: best.date, outstanding: pending });
  }
  return out;
}

export interface SettlePayablesResult {
  settled: number;
  reopened: number;
}

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === '23505';
}

/** Abre otra vez las facturas saldadas cuya salida del banco ya no cuenta. */
async function reopenStale(db: SupabaseClient): Promise<number> {
  const { data, error } = await db
    .from('ledger_movements')
    .select(MOVEMENT_COLUMNS)
    .eq('kind', 'payable')
    .not('settled_by', 'is', null)
    .limit(SCAN);
  if (error) throw error;
  const held = (data ?? []) as MovementRow[];
  if (!held.length) return 0;
  const debitIds = [...new Set(held.map((r) => r.settled_by as string))];
  const alive = new Set<string>();
  for (let i = 0; i < debitIds.length; i += 100) {
    const { data: debits, error: e } = await db
      .from('ledger_movements')
      .select('id, status, duplicate_of, excluded_reason')
      .in('id', debitIds.slice(i, i + 100));
    if (e) throw e;
    for (const d of (debits ?? []) as Array<
      Pick<MovementRow, 'id' | 'status' | 'duplicate_of' | 'excluded_reason'>
    >)
      if (isCounted(d)) alive.add(d.id);
  }
  let reopened = 0;
  for (const p of held) {
    if (alive.has(p.settled_by as string)) continue;
    const { error: e } = await db
      .from('ledger_movements')
      .update({
        status: 'expected',
        settled_at: null,
        outstanding: num(p.settled_by_outstanding) ?? num(p.amount),
        settled_by: null,
        settled_by_outstanding: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', p.id)
      .eq('settled_by', p.settled_by as string);
    if (e) throw e;
    reopened += 1;
  }
  return reopened;
}

/**
 * Ata las salidas del banco a las facturas por pagar que pagaron, y deshace
 * las que ya no se sostienen. Ver la cabecera.
 */
export async function settlePayablesFromBank(db: SupabaseClient): Promise<SettlePayablesResult> {
  const reopened = await reopenStale(db);

  const { data: open, error: openError } = await db
    .from('ledger_movements')
    .select(MOVEMENT_COLUMNS)
    .eq('kind', 'payable')
    .eq('status', 'expected')
    .is('settled_by', null)
    .is('duplicate_of', null)
    .order('date', { ascending: true })
    .limit(SCAN);
  if (openError) throw openError;
  const payables = ((open ?? []) as MovementRow[]).filter(isOpenPayable);
  if (!payables.length) return { settled: 0, reopened };

  const since = payables.reduce((min, p) => (p.date < min ? p.date : min), payables[0]?.date ?? '');
  const [debitsRead, usedRead] = await Promise.all([
    db
      .from('ledger_movements')
      .select(MOVEMENT_COLUMNS)
      .eq('kind', 'expense')
      .eq('direction', 'out')
      .eq('status', 'settled')
      .eq('source_kind', 'bank')
      .is('duplicate_of', null)
      .gte('date', since)
      .order('date', { ascending: true })
      .limit(SCAN),
    db.from('ledger_movements').select('settled_by').not('settled_by', 'is', null).limit(SCAN),
  ]);
  if (debitsRead.error) throw debitsRead.error;
  if (usedRead.error) throw usedRead.error;
  const used = new Set(
    ((usedRead.data ?? []) as Array<{ settled_by: string | null }>)
      .map((r) => r.settled_by)
      .filter((id): id is string => Boolean(id)),
  );
  const matches = matchPayables(payables, (debitsRead.data ?? []) as MovementRow[], used);

  let settled = 0;
  for (const m of matches) {
    const { data, error } = await db
      .from('ledger_movements')
      .update({
        status: 'settled',
        settled_at: m.date,
        outstanding: 0,
        settled_by: m.debitId,
        settled_by_outstanding: m.outstanding,
        updated_at: new Date().toISOString(),
      })
      .eq('id', m.payableId)
      .eq('status', 'expected')
      .is('settled_by', null)
      .select('id');
    if (error) {
      // Otra corrida ató esa salida a la vez: se deja para la próxima.
      if (isUniqueViolation(error)) continue;
      throw error;
    }
    if (((data ?? []) as unknown[]).length) settled += 1;
  }
  return { settled, reopened };
}
