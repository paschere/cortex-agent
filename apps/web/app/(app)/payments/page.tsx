import { CarteraScreen } from '@/components/cartera/CarteraScreen';
import { PageHeader } from '@/components/ui/page-header';
import type { PaymentKind, PaymentState } from '@/lib/payments-shape';
import { PAYMENT_KIND_LABEL } from '@/lib/payments-shape';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { workspaceHref } from '@/lib/workspace-context';
import {
  bogotaToday,
  hydratePayments,
  listClients,
  listPayments,
  listWaitingReports,
  readCartera,
  receivables,
  reportsFor,
  sourceLabel,
  sourceRank,
} from '@cortex/agent-tools';
import { Banknote, Sparkles } from 'lucide-react';
import Link from 'next/link';
import { BankSection } from './_components/BankSection';
import { Fold } from './_components/Fold';
import { Disputes, Ledger, RecordForm } from './_components/PaymentsBoard';
import { RecoveredSection } from './_components/RecoveredSection';
import { money, shortDate } from './_components/format';
import type { ClientOption, DisputeView, PaymentView } from './_components/types';
import { applySuggestion } from './bank-actions';

/**
 * Cartera y pagos.
 *
 * ARRIBA LO QUE SE LEE DE UN VISTAZO (`CarteraScreen`): cuánto te deben, cuánto
 * está vencido, cuánto entró este mes y en cuántos días se cobra, con la
 * antigüedad, los clientes, el mes a mes y lo que se espera cobrar. Todo sale de
 * `readCartera` y respeta lo que dice el programa contable: su saldo manda y no
 * se resta dos veces.
 *
 * ABAJO, PLEGADO, LO QUE YA EXISTÍA y no se quitó: disputas entre fuentes,
 * facturas leídas sin revisar, lo recuperado con Cortex, anotar un pago, el
 * extracto del banco y el registro completo de pagos. Cada uno lleva su cuenta
 * al lado del título para que se vea cuándo hay algo que mirar.
 */

export const dynamic = 'force-dynamic';

const SCAN = 120;

export default async function PaymentsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  const today = bogotaToday();
  const q = await searchParams;
  // «¿Y si las facturas sin plazo se cobraran a N días?»: sólo para mirar.
  const rawPlazo = typeof q.plazo === 'string' ? Number(q.plazo) : Number.NaN;
  const plazo = Number.isInteger(rawPlazo) && rawPlazo > 0 && rawPlazo <= 365 ? rawPlazo : null;

  const [model, cartera, recent, disputedRows, waiting, clients] = await Promise.all([
    readCartera(db, { today, defaultTermDays: plazo }),
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
    amountValue: row.kind === 'reversal' ? -Number(row.amount) : Number(row.amount),
    currency: row.currency,
    paidOn: shortDate(row.paid_on),
    paidOnIso: String(row.paid_on).slice(0, 10),
    client: row.client_name ?? null,
    invoiceNumber: row.invoice_number,
    state: row.state as PaymentState,
    sourceCount: row.source_count,
  }));

  const clientOptions: ClientOption[] = clients.map((c) => ({ id: c.id, name: c.name }));
  const askHref = `/chat?prompt=${encodeURIComponent(
    '¿Cómo va la cartera? Dime quién me debe más, qué está vencido y a quién debería cobrarle primero.',
  )}`;
  const plazoHref = (days: number | null) => (days ? `/payments?plazo=${days}` : '/payments');
  const stillWaiting = waiting.length + cartera.unappliedPayments;

  return (
    <div className="space-y-6">
      <Link
        href={workspaceHref(user.organization.id, '/finance')}
        className="inline-flex min-h-10 items-center text-sm font-semibold text-primary"
      >
        ← Resumen de Finanzas
      </Link>
      <PageHeader
        title="Cartera y pagos"
        subtitle="Quién te debe, cuánto está vencido y qué se espera cobrar. Los saldos son los de tu programa contable."
        icon={<Banknote className="h-5 w-5" aria-hidden />}
        actions={
          <Link
            href={askHref}
            className="inline-flex min-h-11 items-center gap-2 rounded-pill bg-primary px-5 text-sm font-bold text-white transition-colors hover:bg-primary-strong"
          >
            <Sparkles className="h-4 w-4" aria-hidden />
            Pregúntale a Cortex sobre la cartera
          </Link>
        }
      />

      <CarteraScreen
        model={model}
        actions={{ match: applySuggestion }}
        plazo={plazo}
        plazoHref={plazoHref}
        askHref={askHref}
        sentence={cartera.sentence}
      />

      {/* Lo que ya existía, plegado: se abre con un toque y avisa cuando hay algo. */}
      <div className="space-y-3">
        <Fold
          id="disputas"
          title="Pagos en disputa"
          hint="Cuando dos fuentes cuentan distinto un mismo pago, sale de las cifras hasta que alguien decida."
          badge={
            cartera.disputedPayments > 0 ? `${cartera.disputedPayments} por resolver` : 'Ninguno'
          }
          badgeTone={cartera.disputedPayments > 0 ? 'amber' : 'emerald'}
        >
          <Disputes disputes={disputes} />
        </Fold>

        <Fold
          id="sin-revisar"
          title="Facturas leídas sin revisar"
          hint="Facturas que Cortex leyó de un documento y nadie ha confirmado."
          badge={cartera.pendingExcluded > 0 ? `${cartera.pendingExcluded} sin revisar` : 'Al día'}
          badgeTone={cartera.pendingExcluded > 0 ? 'amber' : 'emerald'}
        >
          <p className="px-2 py-2 text-sm text-ink-muted">
            {cartera.pendingExcluded > 0
              ? `Hay ${cartera.pendingExcluded} ${cartera.pendingExcluded === 1 ? 'factura leída' : 'facturas leídas'} de documentos que nadie ha confirmado, así que todavía no suman en «Por cobrar». Al confirmarlas entran a la cifra.`
              : 'No hay facturas leídas esperando revisión. Todo lo que está en la cartera ya fue confirmado o viene de tu programa contable.'}{' '}
            {cartera.pendingExcluded > 0 ? (
              <Link href="/finance" className="font-semibold text-primary hover:underline">
                Revisar las facturas leídas
              </Link>
            ) : null}
          </p>
        </Fold>

        {/* 0166: la plata que volvió después de que Cortex actuó, con sus pruebas. */}
        <RecoveredSection organizationId={user.organization.id} />

        <Fold
          id="anotar-pago"
          title="Anotar un pago a mano"
          hint="Para lo que no llega solo desde Siigo ni desde el banco. Queda con tu nombre."
        >
          <RecordForm clients={clientOptions} today={today} />
        </Fold>

        {/* El extracto del banco: importar abonos y atar cada uno a su factura. */}
        <Fold
          id="extractos"
          title="Extracto del banco"
          hint="Importa los abonos del banco y átalos a la factura que pagan."
          badge={stillWaiting > 0 ? `${stillWaiting} sin factura` : null}
          badgeTone="amber"
        >
          <BankSection organizationId={user.organization.id} />
        </Fold>

        <Fold
          id="registro"
          title="Registro completo de pagos"
          hint="Todos los pagos con su estado y cuántas fuentes los confirman."
          badge={payments.length > 0 ? `${payments.length}` : null}
        >
          <Ledger payments={payments} />
        </Fold>
      </div>
    </div>
  );
}
