import type { SupabaseClient } from '@supabase/supabase-js';
import { BASE_SOURCE_ID, baseRecord, combineKind, originName } from '../accounting/sources/read';
import { type AccRecord, partyKey } from '../accounting/sources/shape';

/**
 * LAS HOJAS EN LA CIFRA DE `receivables()` (0239).
 *
 * `receivables` es la cifra que dice el chat y que usan la ficha del cliente y
 * los vigilantes. Aquí se le suman las facturas abiertas de las hojas o tablas
 * declaradas como fuente de ventas, SIN repetir las que ya están como
 * documento confirmado o como factura del programa contable, y se devuelve qué
 * facturas de esos dos lados debe saltarse (cuando una fuente manda sobre el
 * programa). Nunca lanza: sin fuentes (o sin la migración) devuelve vacío.
 */

export interface SheetReceivablesInput {
  today: string;
  clientId?: string;
  documents: Array<{
    id: string;
    number: string;
    nit: string | null;
    total: number | null;
    paid: number;
    currency: string | null;
    issuedOn: string | null;
    dueOn: string | null;
  }>;
  accounting: Array<{
    id: string;
    source_system: string;
    doc_number: string;
    client_nit?: string | null;
    counterparty_name: string | null;
    currency: string;
    total: number | string;
    balance: number | string;
    issued_on: string | null;
    due_on: string | null;
  }>;
}

export interface SheetReceivables {
  /** Facturas de hojas con saldo, que no estaban ya en otro lado. */
  invoices: AccRecord[];
  /** Ids de documentos o facturas del programa que una fuente reemplaza. */
  dropIds: Set<string>;
  origins: string[];
  differences: number;
}

const EMPTY: SheetReceivables = { invoices: [], dropIds: new Set(), origins: [], differences: 0 };

export async function sheetReceivables(
  db: SupabaseClient,
  input: SheetReceivablesInput,
): Promise<SheetReceivables> {
  try {
    const base: AccRecord[] = [];
    for (const d of input.documents) {
      if (d.total === null || !d.currency || !d.issuedOn) continue;
      base.push(
        baseRecord('ventas', {
          rowId: d.id,
          origin: 'Documento leído',
          number: d.number,
          date: d.issuedOn,
          due: d.dueOn,
          nit: d.nit,
          total: d.total,
          balance: d.total - d.paid,
          currency: d.currency,
        }),
      );
    }
    for (const a of input.accounting) {
      if (!a.issued_on) continue;
      base.push(
        baseRecord('ventas', {
          rowId: a.id,
          origin: originName(a.source_system),
          number: a.doc_number,
          date: a.issued_on,
          due: a.due_on,
          nit: a.client_nit,
          party: a.counterparty_name,
          total: Number(a.total),
          balance: Number(a.balance),
          currency: a.currency,
        }),
      );
    }
    const c = await combineKind(db, 'ventas', base);
    if (!c.batches.length) return EMPTY;
    const kept = new Set(
      c.result.records.filter((r) => r.sourceId === BASE_SOURCE_ID).map((r) => r.rowId),
    );
    const dropIds = new Set(base.filter((b) => !kept.has(b.rowId)).map((b) => b.rowId));

    let sheet = c.result.records.filter(
      (r) => r.sourceId !== BASE_SOURCE_ID && !r.creditNote && (r.balance ?? r.total) > 0.005,
    );
    if (input.clientId) {
      // La ficha de un cliente: sólo lo de la hoja que es de ese cliente (NIT o nombre).
      const { data } = await db
        .from('clients')
        .select('name, tax_id')
        .eq('id', input.clientId)
        .maybeSingle();
      const client = data as { name: string; tax_id: string | null } | null;
      if (!client) return { ...EMPTY, dropIds: new Set() };
      const want = partyKey({ nit: (client.tax_id ?? '').replace(/\D/g, ''), party: client.name });
      const wantName = partyKey({ nit: '', party: client.name });
      sheet = sheet.filter((r) => {
        const k = partyKey(r);
        const nitOk = r.nit && want.startsWith('nit:') && want.slice(4).startsWith(r.nit);
        return Boolean(nitOk) || (k !== '' && (k === want || k === wantName));
      });
    }
    return {
      invoices: sheet,
      dropIds,
      origins: [...new Set(sheet.map((r) => r.origin))],
      differences: c.summary.differenceCount,
    };
  } catch {
    return { ...EMPTY, dropIds: new Set() };
  }
}
