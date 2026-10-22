import { carteraNameKey, docKey } from '../../payments/cartera';
import { type AccRecord, type RowIssue, type SourceKind, isInvoiceKind, partyKey } from './shape';

/**
 * COMBINAR LO QUE DICE EL PROGRAMA CONTABLE CON LO QUE DICEN LAS HOJAS (0239).
 *
 * Puro. Entra `base` (lo que ya traen el programa contable y los documentos
 * confirmados, cada registro con su origen) y las fuentes declaradas (hojas),
 * en orden. Sale UNA lista sin repetidos:
 *
 *   - Dedupe por tipo + número + tercero (NIT sin DV; si falta el NIT en un
 *     lado, el nombre). Pagos sin número y movimientos usan fecha + tercero +
 *     valor (+ cuenta).
 *   - Precedencia por fuente: `program` (por defecto) = gana lo que ya estaba;
 *     `sheet` = la hoja reemplaza a lo que ya estaba. Gane quien gane, si el
 *     valor o el saldo no coinciden se lista una DIFERENCIA («FV-102 vale $X
 *     en Siigo y $Y en la hoja»): un aviso, nunca una suma doble.
 */

export type Precedence = 'program' | 'sheet';

export interface SourceBatch {
  sourceId: string;
  label: string;
  precedence: Precedence;
  records: AccRecord[];
  issues: RowIssue[];
}

export interface Difference {
  kind: SourceKind;
  number: string;
  party: string;
  field: 'total' | 'saldo';
  leftOrigin: string;
  leftValue: number;
  rightOrigin: string;
  rightValue: number;
  currency: string;
  /** El origen cuyo valor quedó en las cifras. */
  keptOrigin: string;
  message: string;
}

export interface OriginSummary {
  origin: string;
  /** Registros que quedaron en las cifras. */
  count: number;
  /** Suma de totales en la moneda `currency` (las notas restan). */
  total: number;
  balance: number;
  /** Cuántos de esa fuente se descartaron por estar ya en otra. */
  dropped: number;
}

export interface CombineResult {
  records: AccRecord[];
  differences: Difference[];
  /** Cuántos registros de las hojas ya estaban (no se sumaron otra vez). */
  overlaps: number;
  origins: OriginSummary[];
  issues: RowIssue[];
}

const TOLERANCE = 0.5;

function sameParty(a: AccRecord, b: AccRecord): boolean {
  if (a.nit && b.nit) {
    // Un lado puede traer el DV pegado (10 dígitos) y el otro no.
    if (a.nit === b.nit) return true;
    const [long, short] = a.nit.length > b.nit.length ? [a.nit, b.nit] : [b.nit, a.nit];
    return long.length === short.length + 1 && long.startsWith(short);
  }
  const ka = carteraNameKey(a.party);
  const kb = carteraNameKey(b.party);
  // Sin tercero en alguno de los dos lados, el número solo decide.
  if (!ka || !kb) return true;
  return ka === kb;
}

/** Llave exacta de los tipos sin número de factura único. */
function compositeKey(r: AccRecord): string {
  const money = Math.round(r.total * 100);
  switch (r.kind) {
    case 'pagos_recibidos':
    case 'pagos_proveedores':
      // Sin el tercero: el programa guarda el cliente por id y la hoja por NIT o nombre. Lo que lo
      // identifica es a qué factura pagó (o el recibo), el día y el valor.
      return `${docKey(r.invoiceRef) || docKey(r.number)}|${r.date}|${money}|${r.currency}`;
    case 'movimientos':
      return `${docKey(r.number)}|${r.date}|${r.account ?? ''}|${Math.round((r.debit ?? 0) * 100)}|${Math.round((r.credit ?? 0) * 100)}|${partyKey(r)}`;
    case 'presupuesto':
      return `${r.date.slice(0, 7)}|${(r.account ?? '').toLowerCase()}|${(r.costCenter ?? '').toLowerCase()}|${(r.concept ?? '').toLowerCase()}|${r.currency}`;
    default:
      return '';
  }
}

export function combineRecords(
  kind: SourceKind,
  base: readonly AccRecord[],
  batches: readonly SourceBatch[],
): CombineResult {
  const kept: AccRecord[] = [];
  const dropped = new Map<string, number>();
  const differences: Difference[] = [];
  const issues: RowIssue[] = [];
  let overlaps = 0;

  const byNumber = new Map<string, number[]>(); // facturas: número → posiciones en kept
  const byComposite = new Map<string, number>();

  const index = (r: AccRecord, at: number) => {
    if (isInvoiceKind(kind)) {
      const k = docKey(r.number);
      if (!k) return;
      const l = byNumber.get(k) ?? [];
      l.push(at);
      byNumber.set(k, l);
    } else byComposite.set(compositeKey(r), at);
  };
  const unindex = (r: AccRecord, at: number) => {
    if (isInvoiceKind(kind)) {
      const k = docKey(r.number);
      byNumber.set(
        k,
        (byNumber.get(k) ?? []).filter((x) => x !== at),
      );
    } else if (byComposite.get(compositeKey(r)) === at) byComposite.delete(compositeKey(r));
  };
  const find = (r: AccRecord): number | null => {
    if (isInvoiceKind(kind)) {
      const k = docKey(r.number);
      if (!k) return null;
      for (const at of byNumber.get(k) ?? []) {
        const cand = kept[at] as AccRecord;
        // Las monedas distintas no se mezclan: la misma factura en otra moneda es otra cosa.
        if (cand.currency === r.currency && sameParty(cand, r)) return at;
      }
      return null;
    }
    return byComposite.get(compositeKey(r)) ?? null;
  };

  for (const r of base) {
    kept.push(r);
    index(r, kept.length - 1);
  }

  const compare = (existing: AccRecord, incoming: AccRecord, keptOrigin: string) => {
    if (!isInvoiceKind(kind)) return;
    const pairs: Array<['total' | 'saldo', number | null, number | null]> = [
      ['total', existing.total, incoming.total],
      ['saldo', existing.balance, incoming.balance],
    ];
    for (const [field, a, b] of pairs) {
      if (a === null || b === null || Math.abs(a - b) <= TOLERANCE) continue;
      const money = (n: number) =>
        new Intl.NumberFormat('es-CO', { maximumFractionDigits: 0 }).format(Math.round(n));
      const sym = existing.currency === 'COP' ? '$' : `${existing.currency} `;
      differences.push({
        kind,
        number: existing.number || incoming.number,
        party: existing.party || incoming.party,
        field,
        leftOrigin: existing.origin,
        leftValue: a,
        rightOrigin: incoming.origin,
        rightValue: b,
        currency: existing.currency,
        keptOrigin,
        message: `${existing.number || incoming.number}: ${field === 'total' ? 'el total' : 'el saldo'} vale ${sym}${money(a)} en ${existing.origin} y ${sym}${money(b)} en ${incoming.origin}; en las cifras entra lo de ${keptOrigin}.`,
      });
    }
  };

  for (const batch of batches) {
    for (const r of batch.records) {
      const at = find(r);
      if (at === null) {
        kept.push(r);
        index(r, kept.length - 1);
        continue;
      }
      overlaps += 1;
      const existing = kept[at] as AccRecord;
      if (batch.precedence === 'sheet') {
        compare(existing, r, r.origin);
        dropped.set(existing.origin, (dropped.get(existing.origin) ?? 0) + 1);
        unindex(existing, at);
        kept[at] = r;
        index(r, at);
      } else {
        compare(existing, r, existing.origin);
        dropped.set(r.origin, (dropped.get(r.origin) ?? 0) + 1);
      }
    }
    for (const i of batch.issues) issues.push({ ...i, sourceLabel: batch.label });
  }

  const byOrigin = new Map<string, OriginSummary>();
  for (const r of kept) {
    const s = byOrigin.get(r.origin) ?? {
      origin: r.origin,
      count: 0,
      total: 0,
      balance: 0,
      dropped: 0,
    };
    s.count += 1;
    if (r.currency === 'COP') {
      s.total += r.total;
      s.balance += isInvoiceKind(kind) ? (r.balance ?? r.total) : (r.balance ?? 0);
    }
    byOrigin.set(r.origin, s);
  }
  for (const [origin, n] of dropped) {
    const s = byOrigin.get(origin) ?? { origin, count: 0, total: 0, balance: 0, dropped: 0 };
    s.dropped = n;
    byOrigin.set(origin, s);
  }

  return {
    records: kept,
    differences,
    overlaps,
    origins: [...byOrigin.values()].sort((a, b) => b.count - a.count),
    issues,
  };
}

/**
 * Saldo de las facturas de una hoja que no trae columna de saldo: el total
 * menos los pagos de las hojas que dicen a qué factura pagan. Sin pagos que la
 * nombren queda el total entero y se avisa UNA vez por fuente (no por fila).
 * Pura: devuelve registros nuevos y los avisos.
 */
export function resolveSheetBalances(
  invoices: readonly AccRecord[],
  payments: readonly AccRecord[],
): { records: AccRecord[]; issues: RowIssue[] } {
  const paid = new Map<string, AccRecord[]>();
  for (const p of payments) {
    const k = docKey(p.invoiceRef);
    if (!k) continue;
    const l = paid.get(k) ?? [];
    l.push(p);
    paid.set(k, l);
  }
  const issues: RowIssue[] = [];
  const assumed = new Map<string, number>();
  const records = invoices.map((inv) => {
    if (inv.balance !== null) return inv;
    const list = (paid.get(docKey(inv.number)) ?? []).filter(
      (p) => p.currency === inv.currency && sameParty(p, inv),
    );
    if (!list.length) {
      assumed.set(inv.origin, (assumed.get(inv.origin) ?? 0) + 1);
      // Sin dato: el saldo queda sin decir (quien lo usa toma el total) para no inventar una
      // «diferencia de saldo» contra el programa por algo que la hoja nunca dijo.
      return inv;
    }
    const cobrado = list.reduce((s, p) => s + p.total, 0);
    return { ...inv, balance: inv.creditNote ? inv.total : Math.max(inv.total - cobrado, 0) };
  });
  for (const [origin, n] of assumed)
    issues.push({
      rowId: null,
      code: 'sin_saldo',
      severity: 'aviso',
      sourceLabel: origin,
      message: `${origin}: ${n} factura(s) no traen saldo ni pagos que las nombren; se cuentan como sin pagar. Mapea la columna de saldo o la de «factura que paga» en los pagos para que sea exacto.`,
    });
  return { records, issues };
}
