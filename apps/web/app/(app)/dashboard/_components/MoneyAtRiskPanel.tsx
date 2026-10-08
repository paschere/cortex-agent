import { Panel } from '@/components/ui/panel';
import { chipClass } from '@/lib/status-chip';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { type MoneyRecovered, moneyAtRisk, moneyRecovered } from '@cortex/agent-tools';
import { ArrowUpRight, ShieldAlert, TrendingUp } from 'lucide-react';
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
 *
 * DEBAJO, LO QUE VOLVIÓ (0166). «Recuperado con Cortex: $X este mes / $Y en
 * total», con las facturas que más pesaron y la acción de Cortex que precedió
 * cada pago. La cifra es conservadora (reglas en payments/recovered.ts) y se
 * pinta aunque no haya nada en riesgo: es la prueba de que avisar sirvió.
 */

const COP = new Intl.NumberFormat('es-CO', {
  style: 'currency',
  currency: 'COP',
  maximumFractionDigits: 0,
});
const NUM = new Intl.NumberFormat('es-CO', { maximumFractionDigits: 2 });

function amountIn(value: number, currency: string): string {
  return currency.toUpperCase() === 'COP' ? COP.format(value) : `${NUM.format(value)} ${currency}`;
}

/** «12 sep», desde la cadena y sin construir un Date. */
function dayLabel(iso: string): string {
  const months = [
    'ene',
    'feb',
    'mar',
    'abr',
    'may',
    'jun',
    'jul',
    'ago',
    'sep',
    'oct',
    'nov',
    'dic',
  ];
  const [, m, d] = iso.split('-');
  return `${Number(d)} ${months[Number(m) - 1] ?? m}`;
}

export async function MoneyAtRiskPanel({ organizationId }: { organizationId: string }) {
  const db = getOrgScopedClient(organizationId);
  const [risk, recovered] = await Promise.all([
    moneyAtRisk(db).catch(() => null),
    moneyRecovered(db).catch(() => null),
  ]);
  const others = risk?.otherCurrencies.filter((o) => o.receivablesOverdue > 0) ?? [];
  const atRisk = !!risk && (risk.cop.total > 0 || others.length > 0);
  const gotBack =
    !!recovered && (recovered.cop.total > 0 || recovered.otherCurrencies.some((o) => o.total > 0));
  if (!atRisk && !gotBack) return null;
  if (!risk || !atRisk)
    return (
      <Panel className="mb-4 p-5">{recovered && <RecoveredBlock recovered={recovered} />}</Panel>
    );
  const { cop } = risk;

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
          <p className="mt-1.5 max-w-md text-micro text-ink-faint">
            Suma la cartera ya vencida (lo que te deben) y los pagos y multas por vencer o vencidos
            (lo que debes). La cartera que aún no vence no entra, y cada factura cuenta una sola
            vez.
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
      {gotBack && recovered && (
        <div className="mt-4 border-t border-border pt-4">
          <RecoveredBlock recovered={recovered} />
        </div>
      )}
    </Panel>
  );
}

/** Lo que volvió después de que Cortex actuó, con sus pruebas más grandes. */
function RecoveredBlock({ recovered }: { recovered: MoneyRecovered }) {
  const { cop } = recovered;
  const rows = [
    ...recovered.items.map((it) => ({
      key: `inv:${it.invoiceId}`,
      on: it.lastOn,
      who: `${it.counterparty ?? 'Cliente sin nombre'}${it.docNumber ? ` · ${it.docNumber}` : ''}`,
      amount: amountIn(it.amount, it.currency),
      why: `${it.trigger.label} · ${dayLabel(it.trigger.on)}`,
      href: it.trigger.href,
    })),
    ...recovered.manual
      .filter((m) => m.counted > 0)
      .map((m) => ({
        key: `case:${m.caseId}`,
        on: m.on,
        who: m.title,
        amount: COP.format(m.counted),
        why: `Anotado al cerrar · ${dayLabel(m.on)}`,
        href: m.href,
      })),
  ]
    .sort((a, b) => b.on.localeCompare(a.on))
    .slice(0, 3);
  const otherTotals = recovered.otherCurrencies.filter((o) => o.total > 0);
  return (
    <section aria-label="Plata recuperada con Cortex">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="field-label flex items-center gap-1.5">
            <TrendingUp className="h-3.5 w-3.5 text-emerald" aria-hidden /> Recuperado con Cortex
          </p>
          <p className="mt-1.5 text-sm text-ink-muted">
            <span className="tabular font-mono text-lg font-semibold text-emerald">
              {COP.format(cop.month)}
            </span>{' '}
            este mes ·{' '}
            <span className="tabular font-mono font-semibold text-ink">
              {COP.format(cop.total)}
            </span>{' '}
            en total
          </p>
          {otherTotals.length > 0 && (
            <p className="mt-1 text-micro text-ink-faint">
              Además en otras monedas:{' '}
              {otherTotals.map((o) => `${NUM.format(o.total)} ${o.currency}`).join(', ')}. No se
              suma a los pesos.
            </p>
          )}
        </div>
        <Link
          href="/payments#recuperado"
          className="inline-flex items-center gap-1 text-micro font-semibold text-ink-faint hover:text-ink"
        >
          Ver de dónde sale <ArrowUpRight className="h-3 w-3" aria-hidden />
        </Link>
      </div>
      {rows.length > 0 && (
        <ul className="mt-3 divide-y divide-border text-xs">
          {rows.map((r) => (
            <li
              key={r.key}
              className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-2"
            >
              <span className="min-w-0 truncate text-ink-muted">{r.who}</span>
              <span className="flex shrink-0 items-center gap-2">
                <Link href={r.href} className={chipClass('emerald')}>
                  {r.why}
                </Link>
                <span className="tabular font-mono text-ink">{r.amount}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-2 text-micro text-ink-faint">
        Pagos que llegaron después de un cobro, un seguimiento o un aviso de Cortex, dentro de{' '}
        {recovered.windowDays} días y sólo hasta lo que se debía; más lo anotado al cerrar asuntos
        verificados.
      </p>
    </section>
  );
}
