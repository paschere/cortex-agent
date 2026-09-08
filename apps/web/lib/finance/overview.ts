import {
  type PaymentKind,
  type PaymentState,
  type ReceivablesCurrency,
  bogotaToday,
  hydratePayments,
  listPayments,
  receivables,
} from '@cortex/agent-tools';
import type { SupabaseClient } from '@supabase/supabase-js';

const RECENT_LIMIT = 50;
const DISPUTE_SCAN_LIMIT = 1000;

export type FinanceRead<T> =
  | { status: 'available'; data: T }
  | { status: 'unavailable'; error: string };

export interface FinanceReceivables {
  byCurrency: ReceivablesCurrency[];
  confirmedInvoices: number;
  exclusions: {
    pendingInvoices: number;
    withoutCurrency: number;
    disputedPayments: number;
    unappliedPayments: number;
  };
  truncated: boolean;
  guidance: string;
}

export interface FinanceRecentPayment {
  id: string;
  kind: PaymentKind;
  amount: number;
  currency: string;
  paidOn: string;
  state: PaymentState;
  clientName: string | null;
  invoiceNumber: string | null;
}

export interface FinancePaymentActivity {
  recent: FinanceRecentPayment[];
  disputedCount: number;
  scanLimit: number;
  truncated: boolean;
}

export interface FinanceUpcomingReceivables {
  supported: false;
  reason: string;
}

export interface FinanceProvenance {
  scope: 'organization';
  userId: string | null;
  sources: ['confirmed_invoice_records', 'counted_linked_payments'];
  caveats: string[];
}

export interface FinanceOverview {
  asOf: string;
  receivables: FinanceRead<FinanceReceivables>;
  paymentActivity: FinanceRead<FinancePaymentActivity>;
  upcomingReceivables: FinanceRead<FinanceUpcomingReceivables>;
  provenance: FinanceProvenance;
}

function unavailable<T>(area: string, error: unknown): FinanceRead<T> {
  // Database errors may contain SQL, identifiers, or provider diagnostics. The
  // UI only needs an honest unknown state; operational detail belongs in logs.
  void error;
  return { status: 'unavailable', error: `No se pudo leer ${area}.` };
}

async function readReceivables(
  db: SupabaseClient,
  today: string,
): Promise<FinanceRead<FinanceReceivables>> {
  try {
    const result = await receivables(db, { today });

    // `receivables` predates section-level read states and deliberately falls
    // back to zero when this count fails. The finance hub cannot turn an
    // unknown exclusion into a reassuring zero, so verify the count here.
    const pendingRead = await db
      .from('document_extractions')
      .select('id', { count: 'exact', head: true })
      .eq('review_state', 'pending')
      .eq('doc_type', 'invoice');
    if (pendingRead.error) throw pendingRead.error;
    if (pendingRead.count == null) throw new Error('el conteo de facturas pendientes no respondió');

    return {
      status: 'available',
      data: {
        byCurrency: result.byCurrency,
        confirmedInvoices: result.confirmedInvoices,
        exclusions: {
          pendingInvoices: pendingRead.count,
          withoutCurrency: result.withoutCurrency,
          disputedPayments: result.disputedPayments,
          unappliedPayments: result.unappliedPayments,
        },
        truncated: result.truncated,
        guidance: result.sentence,
      },
    };
  } catch (error) {
    return unavailable('la cartera', error);
  }
}

async function readPaymentActivity(
  db: SupabaseClient,
): Promise<FinanceRead<FinancePaymentActivity>> {
  try {
    const [recentRows, disputes] = await Promise.all([
      listPayments(db, { limit: RECENT_LIMIT }),
      listPayments(db, { state: 'disputed', limit: DISPUTE_SCAN_LIMIT }),
    ]);
    const recent = await hydratePayments(db, recentRows);
    return {
      status: 'available',
      data: {
        recent: recent.map((row) => ({
          id: row.id,
          kind: row.kind,
          amount: Number(row.amount),
          currency: row.currency,
          paidOn: row.paid_on,
          state: row.state,
          clientName: row.client_name ?? null,
          invoiceNumber: row.invoice_number,
        })),
        disputedCount: disputes.length,
        scanLimit: DISPUTE_SCAN_LIMIT,
        truncated: recentRows.length >= RECENT_LIMIT || disputes.length >= DISPUTE_SCAN_LIMIT,
      },
    };
  } catch (error) {
    return unavailable('la actividad de pagos', error);
  }
}

/**
 * Read-only, organization-scoped finance projection.
 *
 * `db` must already be wrapped by `getOrgScopedClient`; this function never
 * accepts or guesses an organization id. Amounts stay separated by currency.
 * It reports accounts receivable and evidence about payments, never bank cash,
 * net cash flow, revenue, profit, or budget.
 */
export async function readFinanceOverview(
  db: SupabaseClient,
  opts: { userId?: string; today?: string } = {},
): Promise<FinanceOverview> {
  const asOf = opts.today ?? bogotaToday();
  const [receivablesRead, activityRead] = await Promise.all([
    readReceivables(db, asOf),
    readPaymentActivity(db),
  ]);

  return {
    asOf,
    receivables: receivablesRead,
    paymentActivity: activityRead,
    upcomingReceivables: {
      status: 'available',
      data: {
        supported: false,
        reason:
          'La lectura contable actual no expone saldos por factura; Cortex no proyecta vencimientos restando pagos por segunda vez.',
      },
    },
    provenance: {
      scope: 'organization',
      userId: opts.userId ?? null,
      sources: ['confirmed_invoice_records', 'counted_linked_payments'],
      caveats: [
        'Cartera no es saldo bancario ni caja disponible.',
        'Los pagos con estado reportado o confirmado sólo reducen cartera cuando están ligados a una factura.',
        'Las facturas registradas alimentan cartera; esta lectura no las presenta como ingresos.',
        'No hay datos de presupuesto en esta lectura.',
      ],
    },
  };
}
