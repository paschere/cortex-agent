import type { SupabaseClient } from '@supabase/supabase-js';
import {
  type AccountingPurchase,
  draftFromAccountingPurchase,
  draftFromExtraction,
} from './intake';
import { purchaseOrderLookup } from './purchase-orders';
import { PAYABLE_COLUMNS, type PayableInvoiceRow } from './shape';
import { companyNit, intakePayable, logIntake, seenRefs, syncLedgerRow } from './store';

/**
 * LOS OTROS DOS CAMINOS: LA BANDEJA/CEREBRO Y EL PROGRAMA CONTABLE.
 *
 *   documento  Una factura leída y confirmada por una persona como «por
 *              pagar» (0076 + 0143) ya está en el libro (sync del libro); aquí
 *              entra al flujo de aprobación enlazada a ESA fila del libro.
 *   contable   Las compras que trae Siigo/Alegra/QuickBooks (cuando el
 *              programa las expone): una compra nueva entra; una que el
 *              programa ya muestra pagada marca la factura pagada (evidencia:
 *              el programa); una anulada se rechaza si no se había decidido.
 */

const DOC_SCAN = 500;

export interface SourceImportResult {
  created: number;
  duplicates: number;
  paid: number;
  errors: string[];
}

function empty(): SourceImportResult {
  return { created: 0, duplicates: 0, paid: 0, errors: [] };
}

export async function importConfirmedDocuments(
  db: SupabaseClient,
  opts: { today: string },
): Promise<SourceImportResult> {
  const out = empty();
  const { data, error } = await db
    .from('document_extractions')
    .select(
      'id, document_id, doc_number, counterparty_nit, counterparty_name, total_amount, tax_amount, currency, issued_on, due_on, created_at',
    )
    .eq('financial_role', 'payable')
    .eq('review_state', 'confirmed')
    .order('created_at', { ascending: false })
    .limit(DOC_SCAN);
  if (error) throw error;
  const docs = (data ?? []) as Array<Parameters<typeof draftFromExtraction>[0]>;
  if (!docs.length) return out;
  const refs = docs.map((d) => `extraction:${d.id}`);
  const seen = await seenRefs(db, 'documento', refs);
  const fresh = docs.filter((d) => !seen.has(`extraction:${d.id}`));
  if (!fresh.length) return out;

  const ledgerByRef = new Map<string, string>();
  for (let i = 0; i < fresh.length; i += 100) {
    const { data: led, error: e } = await db
      .from('ledger_movements')
      .select('id, source_ref')
      .eq('source_kind', 'document')
      .eq('source_system', '')
      .in(
        'source_ref',
        fresh.slice(i, i + 100).map((d) => `extraction:${d.id}`),
      );
    if (e) throw e;
    for (const r of (led ?? []) as Array<{ id: string; source_ref: string }>)
      ledgerByRef.set(r.source_ref, r.id);
  }

  const ourNit = await companyNit(db);
  const lookup = purchaseOrderLookup(db);
  for (const d of fresh) {
    const ref = `extraction:${d.id}`;
    const draft = draftFromExtraction(d, { ledgerMovementId: ledgerByRef.get(ref) ?? null });
    if (!draft) {
      await logIntake(db, {
        channel: 'documento',
        ref,
        outcome: 'no_factura',
        detail: 'La lectura no trae número, valor o moneda.',
      });
      continue;
    }
    try {
      const r = await intakePayable(db, draft, { today: opts.today, ourNit, lookup });
      if (r.outcome === 'creada') out.created += 1;
      else out.duplicates += 1;
      await logIntake(db, {
        channel: 'documento',
        ref,
        outcome: r.outcome,
        invoiceId: r.invoice.id,
      });
    } catch (err) {
      const why = err instanceof Error ? err.message : 'no se pudo guardar';
      out.errors.push(`${d.doc_number ?? d.id}: ${why}`);
      await logIntake(db, { channel: 'documento', ref, outcome: 'error', detail: why });
    }
  }
  return out;
}

export async function importAccountingPurchases(
  db: SupabaseClient,
  purchases: readonly AccountingPurchase[],
  opts: { system: string; today: string },
): Promise<SourceImportResult> {
  const out = empty();
  if (!purchases.length) return out;
  const ourNit = await companyNit(db);
  const lookup = purchaseOrderLookup(db);
  for (const p of purchases) {
    const draft = draftFromAccountingPurchase(p, opts.system);
    try {
      if (p.status === 'annulled') {
        const { data, error } = await db
          .from('payable_invoices')
          .select(PAYABLE_COLUMNS)
          .eq('source', 'contable')
          .eq('source_system', opts.system)
          .eq('source_ref', draft.sourceRef)
          .limit(1);
        if (error) throw error;
        const row = ((data ?? []) as PayableInvoiceRow[])[0];
        if (row && (row.status === 'recibida' || row.status === 'por_aprobar')) {
          const now = new Date().toISOString();
          const patch = {
            status: 'rechazada' as const,
            rejected_at: now,
            rejection_reason: `Anulada en ${opts.system}.`,
            updated_at: now,
          };
          const { error: e } = await db.from('payable_invoices').update(patch).eq('id', row.id);
          if (e) throw e;
          await syncLedgerRow(db, { ...row, ...patch });
        }
        continue;
      }
      const r = await intakePayable(db, draft, { today: opts.today, ourNit, lookup });
      if (r.outcome === 'creada') out.created += 1;
      else out.duplicates += 1;
      const row = r.invoice;
      if (p.status === 'paid' && row.status !== 'pagada' && row.status !== 'rechazada') {
        const now = new Date().toISOString();
        const patch = {
          status: 'pagada' as const,
          paid_at: opts.today,
          paid_evidence: { kind: 'accounting' as const, reference: `${opts.system} ${p.number}` },
          approved_at: row.approved_at ?? now,
          updated_at: now,
        };
        const { error: e } = await db
          .from('payable_invoices')
          .update(patch)
          .eq('id', row.id)
          .eq('status', row.status);
        if (e) throw e;
        await syncLedgerRow(db, { ...row, ...patch });
        out.paid += 1;
      }
    } catch (err) {
      out.errors.push(`${p.number}: ${err instanceof Error ? err.message : 'no se pudo guardar'}`);
    }
  }
  return out;
}
