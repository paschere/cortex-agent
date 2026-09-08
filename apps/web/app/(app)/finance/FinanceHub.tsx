'use client';

import { Panel, PanelHead } from '@/components/ui/panel';
import { Provenance } from '@/components/ui/provenance';
import type { FinanceOverview } from '@/lib/finance/overview';
import { PAYMENT_KIND_LABEL, PAYMENT_STATE_LABEL, PAYMENT_STATE_TONE } from '@/lib/payments-shape';
import { chipClass } from '@/lib/status-chip';
import clsx from 'clsx';
import {
  AlertTriangle,
  ArrowRight,
  Banknote,
  CheckCircle2,
  CircleDollarSign,
  Clock3,
  FileCheck2,
  Landmark,
  Link2,
  ReceiptText,
  Scale,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState, useTransition } from 'react';

type Links = {
  payments: string;
  mission: string;
  integrations: string;
  feed: string;
  review: string;
  sources: string;
};

const linkClass =
  'inline-flex items-center justify-center gap-1.5 rounded-pill border border-border-strong bg-surface px-4 py-2 text-sm font-semibold text-ink transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary';

function money(value: number, currency: string) {
  try {
    return new Intl.NumberFormat('es-CO', {
      style: 'currency',
      currency,
      maximumFractionDigits: currency === 'COP' ? 0 : 2,
    }).format(value);
  } catch {
    return `${currency} ${value.toLocaleString('es-CO')}`;
  }
}

function date(value: string) {
  const parsed = new Date(`${value}T12:00:00`);
  return Number.isNaN(parsed.valueOf())
    ? value
    : new Intl.DateTimeFormat('es-CO', { day: 'numeric', month: 'short', year: 'numeric' }).format(
        parsed,
      );
}

function Unavailable({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="px-5 py-8 text-center">
      <AlertTriangle className="mx-auto h-5 w-5 text-amber" aria-hidden />
      <p className="mt-2 text-sm font-semibold text-ink">{title}</p>
      <p className="mx-auto mt-1 max-w-xl text-xs leading-relaxed text-ink-muted">{detail}</p>
    </div>
  );
}

export function FinanceHub({ overview, links }: { overview: FinanceOverview; links: Links }) {
  const currencies = useMemo(() => {
    const values = new Set<string>();
    if (overview.receivables.status === 'available') {
      for (const row of overview.receivables.data.byCurrency) values.add(row.currency);
    }
    if (overview.paymentActivity.status === 'available') {
      for (const row of overview.paymentActivity.data.recent) values.add(row.currency);
    }
    return [...values].sort();
  }, [overview]);
  const [currency, setCurrency] = useState(currencies[0] ?? '');
  const effectiveCurrency = currencies.includes(currency) ? currency : (currencies[0] ?? '');
  const router = useRouter();
  const [refreshing, startRefresh] = useTransition();
  const receivable =
    overview.receivables.status === 'available'
      ? overview.receivables.data.byCurrency.find((row) => row.currency === effectiveCurrency)
      : undefined;
  const payments =
    overview.paymentActivity.status === 'available'
      ? overview.paymentActivity.data.recent.filter(
          (row) => !effectiveCurrency || row.currency === effectiveCurrency,
        )
      : [];
  const exclusions =
    overview.receivables.status === 'available' ? overview.receivables.data.exclusions : null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-border bg-surface px-4 py-3">
        <div>
          <p className="text-sm font-semibold text-ink">Vista financiera operativa</p>
          <p className="mt-0.5 text-xs text-ink-muted">
            Primera versión · fecha usada para el cálculo: {date(overview.asOf)}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {currencies.length > 0 ? (
            <label className="flex items-center gap-2 text-xs font-medium text-ink-muted">
              Moneda
              <select
                value={effectiveCurrency}
                onChange={(event) => setCurrency(event.target.value)}
                className="min-h-9 rounded-sm border border-border-strong bg-surface px-3 text-sm font-semibold text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                aria-label="Filtrar finanzas por moneda"
              >
                {currencies.map((item) => (
                  <option key={item}>{item}</option>
                ))}
              </select>
            </label>
          ) : null}
          <button
            className={linkClass}
            type="button"
            disabled={refreshing}
            onClick={() => startRefresh(() => router.refresh())}
          >
            {refreshing ? 'Actualizando…' : 'Actualizar'}
          </button>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Metric
          label="Cartera estimada"
          value={receivable ? money(receivable.outstanding, receivable.currency) : 'No disponible'}
          note={
            receivable
              ? `${receivable.openInvoices} facturas confirmadas abiertas`
              : 'Sin una cifra sustentada para mostrar'
          }
          icon={<CircleDollarSign className="h-4 w-4" />}
        />
        <Metric
          label="Vencido estimado"
          value={receivable ? money(receivable.overdue, receivable.currency) : 'No disponible'}
          note={
            receivable
              ? `${receivable.overdueInvoices} facturas confirmadas vencidas`
              : 'Requiere facturas confirmadas'
          }
          icon={<Clock3 className="h-4 w-4" />}
          tone={receivable?.overdueInvoices ? 'amber' : 'neutral'}
        />
        <Metric
          label="Saldo bancario"
          value="No disponible"
          note="Los saldos bancarios aún no están integrados en este resumen"
          icon={<Landmark className="h-4 w-4" />}
          tone="neutral"
        />
        <Metric
          label="Costos y resultado"
          value="No disponible"
          note="Costos y resultados aún no están integrados en este resumen"
          icon={<ReceiptText className="h-4 w-4" />}
          tone="neutral"
        />
      </div>

      <div className="flex gap-3 rounded-card border border-amber/20 bg-amber-soft px-4 py-3 text-xs leading-relaxed text-ink-muted">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber" aria-hidden />
        <p>
          <span className="font-semibold text-ink">Regla de inclusión:</span> una etiqueta
          financiera no cambia los totales. Cartera solo incluye datos de factura confirmados por
          una persona y clasificados como por cobrar; las cuentas por pagar permanecen separadas.
        </p>
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.45fr)_minmax(300px,.75fr)]">
        <div className="space-y-6">
          <Panel className="overflow-hidden">
            <PanelHead
              icon={<Banknote className="h-4 w-4" />}
              title="Cartera por cobrar"
              right={effectiveCurrency || undefined}
            />
            {overview.receivables.status === 'unavailable' ? (
              <Unavailable title="No pudimos leer la cartera" detail={overview.receivables.error} />
            ) : receivable ? (
              <div>
                <div className="grid gap-4 px-5 py-5 sm:grid-cols-3">
                  <Amount
                    label="Facturado"
                    value={money(receivable.invoiced, receivable.currency)}
                  />
                  <Amount
                    label="Pagado y aplicado"
                    value={money(receivable.paid, receivable.currency)}
                  />
                  <Amount
                    label="Pendiente"
                    value={money(receivable.outstanding, receivable.currency)}
                    strong
                  />
                </div>
                <div className="border-t border-border bg-surface-2 px-5 py-3 text-xs leading-relaxed text-ink-muted">
                  {overview.receivables.data.guidance}
                  {overview.receivables.data.truncated
                    ? ' La lectura alcanzó su límite; abre Cartera para revisar el detalle.'
                    : ''}
                </div>
              </div>
            ) : (
              <Unavailable
                title="No hay cartera confirmada"
                detail="Revisa o carga facturas para construir una cifra que pueda auditarse."
              />
            )}
          </Panel>

          <Panel className="overflow-hidden">
            <PanelHead
              icon={<CheckCircle2 className="h-4 w-4" />}
              title="Actividad de pagos"
              right={payments.length ? `${payments.length} recientes` : undefined}
            />
            {overview.paymentActivity.status === 'unavailable' ? (
              <Unavailable
                title="No pudimos leer los pagos"
                detail={overview.paymentActivity.error}
              />
            ) : payments.length === 0 ? (
              <Unavailable
                title="No hay registros de pago en esta moneda"
                detail="Los pagos registrados aparecerán aquí junto con su fecha, cliente y factura vinculada."
              />
            ) : (
              <ul className="divide-y divide-border">
                {payments.map((payment) => (
                  <li
                    key={payment.id}
                    className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3.5"
                  >
                    <div className="min-w-[180px] flex-1">
                      <p className="truncate text-sm font-semibold text-ink">
                        {payment.clientName ?? 'Cliente sin identificar'}
                      </p>
                      <p className="mt-0.5 text-xs text-ink-muted">
                        {date(payment.paidOn)}
                        {payment.invoiceNumber
                          ? ` · Factura ${payment.invoiceNumber}`
                          : ' · Sin factura vinculada'}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={chipClass(PAYMENT_STATE_TONE[payment.state])}>
                        {PAYMENT_STATE_LABEL[payment.state]}
                      </span>
                      <span className={chipClass('neutral')}>
                        {PAYMENT_KIND_LABEL[payment.kind]}
                      </span>
                      <Provenance
                        source="Registro de pagos"
                        detail={PAYMENT_STATE_LABEL[payment.state]}
                      />
                    </div>
                    <span className="stat-num text-sm font-semibold text-ink">
                      {money(payment.amount, payment.currency)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {overview.paymentActivity.status === 'available' &&
            overview.paymentActivity.data.truncated ? (
              <p className="border-t border-border bg-surface-2 px-5 py-3 text-xs text-ink-muted">
                Actividad limitada a los 50 registros más recientes; las disputas se cuentan hasta
                1.000 registros. Abre el registro para consultar el detalle.
              </p>
            ) : null}
            <div className="border-t border-border px-5 py-3">
              <Link href={links.payments} className={linkClass}>
                Abrir registro de pagos <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            </div>
          </Panel>
        </div>

        <aside className="space-y-6">
          <Panel className="overflow-hidden">
            <PanelHead icon={<Scale className="h-4 w-4" />} title="Requiere revisión" />
            <div className="space-y-3 p-5">
              <QueueRow
                label="Facturas sin rol financiero"
                value={exclusions?.unclassifiedInvoices}
                href={links.sources}
                alert
              />
              <QueueRow
                label="Facturas sin confirmar"
                value={exclusions?.pendingInvoices}
                href={links.review}
              />
              <QueueRow
                label="Pagos en disputa"
                value={
                  exclusions?.disputedPayments ??
                  (overview.paymentActivity.status === 'available'
                    ? overview.paymentActivity.data.disputedCount
                    : undefined)
                }
                href={links.payments}
                alert
              />
              <QueueRow
                label="Pagos sin aplicar"
                value={exclusions?.unappliedPayments}
                href={links.payments}
              />
              <QueueRow
                label="Facturas sin moneda"
                value={exclusions?.withoutCurrency}
                href={links.review}
              />
            </div>
          </Panel>

          <Panel className="overflow-hidden">
            <PanelHead
              icon={<FileCheck2 className="h-4 w-4" />}
              title="Completar la foto financiera"
            />
            <div className="space-y-4 p-5 text-sm">
              <NextStep
                icon={<Scale />}
                title="Clasificar fuentes"
                detail="Define el área, el rol financiero y revisa el impacto antes de guardar."
                href={links.sources}
              />
              <NextStep
                icon={<ReceiptText />}
                title="Revisar con Cortex"
                detail="Confirma las facturas leídas antes de incluirlas."
                href={links.review}
              />
              <NextStep
                icon={<FileCheck2 />}
                title="Consultar archivo temporal"
                detail="Abre comprobantes y facturas recién cargados en Feed."
                href={links.feed}
              />
              <NextStep
                icon={<Link2 />}
                title="Conectar fuentes"
                detail="Añade banco o contabilidad para ampliar cobertura."
                href={links.integrations}
              />
              <NextStep
                icon={<CircleDollarSign />}
                title="Activar cobro"
                detail="Lleva una factura confirmada hasta su cierre."
                href={links.mission}
              />
            </div>
          </Panel>

          <Panel className="overflow-hidden">
            <PanelHead icon={<Clock3 className="h-4 w-4" />} title="Próximos cobros" />
            <Unavailable
              title="Aún no se puede proyectar"
              detail={
                overview.upcomingReceivables.status === 'available'
                  ? overview.upcomingReceivables.data.reason
                  : overview.upcomingReceivables.error
              }
            />
          </Panel>

          <p className="px-1 text-xs leading-relaxed text-ink-faint">
            Esta vista incluye registros de factura confirmados y pagos vinculados que cuentan. No
            calcula caja, ingresos, gastos, rentabilidad ni proyecciones sin una fuente suficiente.
          </p>
        </aside>
      </div>
    </div>
  );
}

function Metric({
  label,
  value,
  note,
  icon,
  tone = 'primary',
}: {
  label: string;
  value: string;
  note: string;
  icon: React.ReactNode;
  tone?: 'primary' | 'amber' | 'neutral';
}) {
  return (
    <div className="rounded-card border border-border bg-surface p-5">
      <div className="flex items-start justify-between gap-3">
        <span className="text-sm font-medium text-ink-muted">{label}</span>
        <span
          className={clsx(
            'grid h-8 w-8 place-items-center rounded-sm',
            tone === 'amber'
              ? 'bg-amber-soft text-amber'
              : tone === 'primary'
                ? 'bg-primary-soft text-primary'
                : 'bg-surface-2 text-ink-faint',
          )}
        >
          {icon}
        </span>
      </div>
      <p
        className={clsx(
          'stat-num mt-3 font-semibold leading-none text-ink',
          value === 'No disponible' ? 'text-lg' : 'text-2xl',
        )}
      >
        {value}
      </p>
      <p className="mt-2 text-xs text-ink-faint">{note}</p>
    </div>
  );
}

function Amount({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div>
      <p className="field-label">{label}</p>
      <p className={clsx('stat-num mt-2 text-lg text-ink', strong && 'font-bold')}>{value}</p>
    </div>
  );
}

function QueueRow({
  label,
  value,
  href,
  alert,
}: { label: string; value?: number; href: string; alert?: boolean }) {
  return (
    <Link
      href={href}
      className="flex items-center justify-between gap-3 rounded-sm border border-border bg-surface-2 px-3 py-2.5 transition-colors hover:border-border-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
    >
      <span className="text-xs font-medium text-ink-muted">{label}</span>
      <span
        className={
          value == null ? chipClass('neutral') : chipClass(alert && value > 0 ? 'amber' : 'neutral')
        }
      >
        {value == null ? 'No disponible' : value}
      </span>
    </Link>
  );
}

function NextStep({
  icon,
  title,
  detail,
  href,
}: {
  icon: React.ReactElement<{ className?: string }>;
  title: string;
  detail: string;
  href: string;
}) {
  return (
    <Link
      href={href}
      className="group flex gap-3 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
    >
      <span className="mt-0.5 text-primary">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1 font-semibold text-ink group-hover:text-primary">
          {title}
          <ArrowRight className="h-3.5 w-3.5" />
        </span>
        <span className="mt-0.5 block text-xs leading-relaxed text-ink-muted">{detail}</span>
      </span>
    </Link>
  );
}
