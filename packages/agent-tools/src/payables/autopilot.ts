import type { SupabaseClient } from '@supabase/supabase-js';
import type { SnapshotSupplierInvoices } from '../autopilot/collectors';
import {
  AWAITING_APPROVAL,
  PAYABLE_COLUMNS,
  type PayableInvoiceRow,
  adaptPayable,
  round2,
} from './shape';

/**
 * Lo que el piloto automático necesita de cuentas por pagar: las facturas que
 * esperan aprobación, la que vence primero adelante. Sin facturas, undefined.
 */
export async function supplierInvoicesSnapshot(
  db: SupabaseClient,
  currency = 'COP',
): Promise<SnapshotSupplierInvoices | undefined> {
  const { data, error } = await db
    .from('payable_invoices')
    .select(PAYABLE_COLUMNS)
    .in('status', [...AWAITING_APPROVAL])
    .order('due_date', { ascending: true, nullsFirst: false })
    .limit(200);
  if (error) throw error;
  const rows = ((data ?? []) as PayableInvoiceRow[]).map(adaptPayable);
  if (!rows.length) return undefined;
  const first = rows.find((r) => r.dueDate) ?? rows[0];
  return {
    ids: rows.slice(0, 25).map((r) => r.id),
    count: rows.length,
    amount: round2(
      rows.filter((r) => r.currency === currency).reduce((s, r) => s + r.netAmount, 0),
    ),
    currency,
    firstDue: first?.dueDate ?? null,
    firstLabel: first ? `${first.supplierName} ${first.docNumber}` : null,
    flagged: rows.filter((r) => r.checks.some((c) => c.severity !== 'info')).length,
  };
}
