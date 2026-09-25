import { Panel } from '@/components/ui/panel';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { moneyAtRisk } from '@cortex/agent-tools';
import { ArrowUpRight, ShieldAlert } from 'lucide-react';
import Link from 'next/link';

/**
 * PLATA EN RIESGO, ARRIBA DE TODO LO DEMÁS DE INICIO.
 *
 * La cifra que un gerente quiere ver al abrir el día, con sus partes: cartera
 * vencida, lo que hay que pagar esta semana y las multas pendientes. Todo sale
 * de datos confirmados en el espacio (ver payments/risk.ts); si no hay nada en
 * riesgo, no se pinta nada — un «$ 0» en cada visita es ruido.
 *
 * En su propio Suspense: la cartera lee hasta mil facturas y no puede demorar
 * «lo que te espera».
 */

const COP = new Intl.NumberFormat('es-CO', {
  style: 'currency',
  currency: 'COP',
  maximumFractionDigits: 0,
});
const NUM = new Intl.NumberFormat('es-CO', { maximumFractionDigits: 2 });

export async function MoneyAtRiskPanel({ organizationId }: { organizationId: string }) {
  const risk = await moneyAtRisk(getOrgScopedClient(organizationId)).catch(() => null);
  if (!risk) return null;
  const { cop } = risk;
  const others = risk.otherCurrencies.filter((o) => o.receivablesOverdue > 0);
  if (cop.total <= 0 && !others.length) return null;

  const parts = [
    {
      label: 'Cartera vencida',
      value: cop.receivablesOverdue,
      note: `${cop.overdueInvoices} facturas`,
      href: '/payments',
    },
    {
      label: 'Por pagar (vencido o esta semana)',
      value: cop.paymentsOverdue + cop.paymentsDueSoon,
      note: `${cop.paymentCommitments} pagos`,
      href: '/commitments',
    },
    {
      label: 'Multas pendientes',
      value: cop.finesPending,
      note: `${cop.fines} comparendos`,
      href: '/commitments',
    },
  ].filter((p) => p.value > 0);

  return (
    <Panel className="mb-4 p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="field-label flex items-center gap-1.5">
            <ShieldAlert className="h-3.5 w-3.5 text-rose" aria-hidden /> Plata en riesgo
          </p>
          <p className="tabular mt-1.5 font-mono text-display font-semibold leading-none text-ink">
            {COP.format(cop.total)}
          </p>
          {others.length > 0 && (
            <p className="mt-1.5 text-micro text-ink-faint">
              Además vencido en otras monedas:{' '}
              {others.map((o) => `${NUM.format(o.receivablesOverdue)} ${o.currency}`).join(', ')}.
              No se suma a los pesos.
            </p>
          )}
        </div>
        <div className="grid w-full gap-2 sm:w-auto sm:grid-cols-3">
          {parts.map((p) => (
            <Link
              key={p.label}
              href={p.href}
              className="group rounded-sm border border-border bg-surface-2/60 px-3 py-2 transition-colors hover:border-border-strong"
            >
              <span className="block text-micro text-ink-faint">{p.label}</span>
              <span className="tabular block font-mono text-sm font-semibold text-ink">
                {COP.format(p.value)}
              </span>
              <span className="flex items-center gap-1 text-micro text-ink-faint group-hover:text-ink">
                {p.note} <ArrowUpRight className="h-3 w-3" />
              </span>
            </Link>
          ))}
        </div>
      </div>
      {risk.topInvoices.length > 0 && (
        <ul className="mt-4 divide-y divide-border border-t border-border text-xs">
          {risk.topInvoices.slice(0, 3).map((inv) => (
            <li key={inv.id} className="flex items-center justify-between gap-3 py-2">
              <span className="min-w-0 truncate text-ink-muted">
                {inv.counterparty ?? 'Cliente sin nombre'}
                {inv.docNumber ? ` · ${inv.docNumber}` : ''}
              </span>
              <span className="tabular shrink-0 font-mono text-ink">
                {inv.currency.toUpperCase() === 'COP'
                  ? COP.format(inv.balance)
                  : `${NUM.format(inv.balance)} ${inv.currency}`}
                <span className="ml-2 text-rose">{inv.daysOverdue} d</span>
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 text-micro text-ink-faint">
        Sólo datos confirmados: facturas por cobrar con su saldo después de pagos, pagos
        comprometidos con valor y multas que el SIMIT ya reportó.
      </p>
    </Panel>
  );
}
