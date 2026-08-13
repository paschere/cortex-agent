import { PageHeader } from '@/components/ui/page-header';
import { StatCard } from '@/components/ui/panel';
import type { PaymentKind, PaymentState } from '@/lib/payments-shape';
import { PAYMENT_KIND_LABEL } from '@/lib/payments-shape';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import {
  bogotaToday,
  hydratePayments,
  listClients,
  listPayments,
  listWaitingReports,
  receivables,
  reportsFor,
  sourceLabel,
  sourceRank,
} from '@cortex/agent-tools';
import { AlertTriangle, Banknote, FileWarning, Scale } from 'lucide-react';
import { PaymentsBoard } from './_components/PaymentsBoard';
import { money, shortDate } from './_components/format';
import type {
  ClientOption,
  CurrencyView,
  DisputeView,
  PaymentView,
  ReceivablesView,
} from './_components/types';

/**
 * Pagos.
 *
 * LA PANTALLA QUE CIERRA LA RESTA. Desde la 0076 Cortex sabía leer una factura;
 * no sabía si estaba pagada, así que no podía dar una sola cifra de negocio —
 * la cartera es una resta y sólo existía el minuendo. Esto es el sustraendo, y
 * viene de varias fuentes a la vez: el contable escribiéndolo aquí, un
 * comprobante que llegó por correo, y mañana Siigo o el banco.
 *
 * TRES COSAS COMPARTEN LA PANTALLA, Y EL ORDEN ES EL ARGUMENTO:
 *
 *   ARRIBA, LA CARTERA CON SU CONFESIÓN AL LADO. La cifra nunca aparece sola:
 *   dice sobre cuántas facturas confirmadas está hecha y cuántas hay sin
 *   revisar que no entran. No es una nota al pie, es lo que hace que el número
 *   sea honesto — y es lo que crea el incentivo correcto para que alguien
 *   revise las que faltan.
 *
 *   DEBAJO, LAS DISPUTAS. Cuando dos fuentes discrepan, el pago sale de todas
 *   las cifras y aparece aquí con lo que dijo cada una. La lista viene ordenada
 *   por la fuente más fuerte, y ese orden sólo dice por dónde empezar a mirar:
 *   la casilla marcada es una sugerencia y quien decide es quien está leyendo.
 *
 *   ABAJO, ANOTAR UN PAGO Y LA LISTA DE LO QUE HAY. Sin ninguna integración
 *   conectada, esas dos cosas ya son un producto usable.
 */

export const dynamic = 'force-dynamic';

const SCAN = 120;

export default async function PaymentsPage() {
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  const today = bogotaToday();

  const [cartera, recent, disputedRows, waiting, clients] = await Promise.all([
    receivables(db, { today }),
    hydratePayments(db, await listPayments(db, { limit: SCAN })),
    hydratePayments(db, await listPayments(db, { state: 'disputed', limit: 25 })),
    listWaitingReports(db, 100),
    listClients(db, { limit: 500 }),
  ]);

  const versionsBy = await reportsFor(
    db,
    disputedRows.map((r) => r.id),
  );

  const byCurrency: CurrencyView[] = cartera.byCurrency.map((c) => ({
    currency: c.currency,
    outstanding: money(c.outstanding, c.currency),
    outstandingValue: c.outstanding,
    invoiced: money(c.invoiced, c.currency),
    paid: money(c.paid, c.currency),
    openInvoices: c.openInvoices,
    ageDays: c.ageDays,
    overdue: money(c.overdue, c.currency),
    overdueInvoices: c.overdueInvoices,
  }));

  const view: ReceivablesView = {
    today,
    byCurrency,
    confirmedInvoices: cartera.confirmedInvoices,
    pendingExcluded: cartera.pendingExcluded,
    disputedPayments: cartera.disputedPayments,
    unappliedPayments: cartera.unappliedPayments,
    sentence: cartera.sentence,
  };

  const disputes: DisputeView[] = disputedRows.map((row) => {
    const versions = (versionsBy.get(row.id) ?? [])
      .map((r) => ({
        source: sourceLabel(r.source_kind, r.source_system),
        amount: money(Number(r.amount), r.currency),
        amountValue: Number(r.amount),
        currency: r.currency,
        paidOn: shortDate(r.paid_on),
        quote: r.source_quote,
        rank: sourceRank(r.source_kind, r.source_system),
      }))
      // LA JERARQUÍA, HACIENDO LO ÚNICO QUE SABE HACER: ordenar una lista y
      // marcar una casilla. Que el extracto del banco salga primero no lo hace
      // tener razón — un extracto que malinterpreta una reversión es
      // exactamente el caso donde no la tiene.
      .sort((a, b) => b.rank - a.rank);
    return {
      paymentId: row.id,
      client: row.client_name ?? null,
      currency: row.currency,
      standingAmount: money(Number(row.amount), row.currency),
      standingValue: Number(row.amount),
      paidOn: shortDate(row.paid_on),
      invoiceNumber: row.invoice_number,
      versions,
      suggested: versionsBy.get(row.id)?.length
        ? Number(
            [...(versionsBy.get(row.id) ?? [])].sort(
              (a, b) =>
                sourceRank(b.source_kind, b.source_system) -
                sourceRank(a.source_kind, a.source_system),
            )[0]?.amount ?? row.amount,
          )
        : Number(row.amount),
      note: row.dispute_note,
    };
  });

  const payments: PaymentView[] = recent.map((row) => ({
    id: row.id,
    kind: row.kind as PaymentKind,
    kindLabel: PAYMENT_KIND_LABEL[row.kind as PaymentKind],
    amount: money(Number(row.amount), row.currency),
    currency: row.currency,
    paidOn: shortDate(row.paid_on),
    client: row.client_name ?? null,
    invoiceNumber: row.invoice_number,
    state: row.state as PaymentState,
    sourceCount: row.source_count,
  }));

  const clientOptions: ClientOption[] = clients.map((c) => ({ id: c.id, name: c.name }));
  const headline = byCurrency[0];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Pagos"
        subtitle="Lo que de verdad entró, y quién lo dice. A mano, desde un comprobante, o desde el sistema contable el día que se conecte."
        icon={<Banknote className="h-5 w-5" aria-hidden />}
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Cartera"
          value={headline ? headline.outstanding : 'Sin cartera'}
          sub={
            headline?.ageDays != null
              ? `a ${headline.ageDays} días, en ${headline.openInvoices} factura(s)`
              : 'sobre facturas confirmadas'
          }
          icon={<Banknote className="h-4 w-4" aria-hidden />}
          tone="primary"
        />
        <StatCard
          label="Sin revisar"
          value={String(cartera.pendingExcluded)}
          sub="facturas leídas que NO están en la cifra"
          icon={<FileWarning className="h-4 w-4" aria-hidden />}
          tone={cartera.pendingExcluded > 0 ? 'amber' : 'emerald'}
          delay={60}
        />
        <StatCard
          label="En disputa"
          value={String(cartera.disputedPayments)}
          sub="pagos que dos fuentes cuentan distinto"
          icon={<Scale className="h-4 w-4" aria-hidden />}
          tone={cartera.disputedPayments > 0 ? 'amber' : 'emerald'}
          delay={120}
        />
        <StatCard
          label="Sin emparejar"
          value={String(waiting.length + cartera.unappliedPayments)}
          sub="reportes y pagos sin factura a la que atribuirse"
          icon={<AlertTriangle className="h-4 w-4" aria-hidden />}
          tone={waiting.length + cartera.unappliedPayments > 0 ? 'sky' : 'emerald'}
          delay={180}
        />
      </div>

      <PaymentsBoard
        receivables={view}
        disputes={disputes}
        payments={payments}
        clients={clientOptions}
        today={today}
      />
    </div>
  );
}
