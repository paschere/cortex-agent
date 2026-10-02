import {
  type DuePanel,
  type DueParty,
  type DueSide,
  PAYROLL_LABEL,
  type Piece,
  chatHref,
  formatDay,
  formatMoney,
} from '@/lib/finance/dashboard-shape';
import { ArrowRight, HandCoins, Lock, Receipt } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { NoData, Section, statusPill } from './pieces';

/**
 * QUIÉN ME DEBE / A QUIÉN LE DEBO: los cinco que más pesan de cada lado, por
 * su saldo pendiente, con el vencimiento más cercano y los días de atraso.
 */
export function DueSection({
  due,
  payments,
  chat,
}: {
  due: Piece<DuePanel>;
  payments: string;
  chat: string;
}) {
  if (!due.ok) {
    return (
      <div className="grid gap-6 lg:grid-cols-2">
        <Section
          id="me-deben"
          title="Quién me debe"
          icon={<HandCoins className="h-4 w-4" aria-hidden />}
        >
          <NoData reason={due.error} />
        </Section>
        <Section
          id="debo"
          title="A quién le debo"
          icon={<Receipt className="h-4 w-4" aria-hidden />}
        >
          <NoData reason={due.error} />
        </Section>
      </div>
    );
  }
  const { receivable, payable, currency, payrollHidden } = due.data;
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Side
        id="me-deben"
        title="Quién me debe"
        icon={<HandCoins className="h-4 w-4" aria-hidden />}
        side={receivable}
        currency={currency}
        empty="Nadie te debe nada pendiente en el libro."
        link={{ href: payments, label: 'Ver cartera y cobros' }}
      />
      <Side
        id="debo"
        title="A quién le debo"
        icon={<Receipt className="h-4 w-4" aria-hidden />}
        side={payable}
        currency={currency}
        empty="No tienes facturas por pagar en el libro."
        link={{
          href: chatHref(
            chat,
            'Muéstrame lo que debo pagar en las próximas cuatro semanas, de lo más urgente a lo menos, con su vencimiento.',
          ),
          label: 'Planear los pagos con Cortex',
        }}
        extra={
          payrollHidden > 0 ? (
            <li className="flex items-center justify-between gap-3 py-2.5 text-sm">
              <span className="flex items-center gap-1.5 text-ink-muted">
                <Lock className="h-3.5 w-3.5" aria-hidden />
                {PAYROLL_LABEL}
              </span>
              <span className="tabular font-mono font-semibold text-ink">
                {formatMoney(payrollHidden, currency)}
              </span>
            </li>
          ) : null
        }
      />
    </div>
  );
}

function Side({
  id,
  title,
  icon,
  side,
  currency,
  empty,
  link,
  extra,
}: {
  id: string;
  title: string;
  icon: ReactNode;
  side: DueSide;
  currency: string;
  empty: string;
  link: { href: string; label: string };
  extra?: ReactNode;
}) {
  const fm = (n: number) => formatMoney(n, currency);
  return (
    <Section
      id={id}
      title={title}
      icon={icon}
      subtitle={
        side.total > 0 ? (
          <>
            <span className="tabular font-mono font-semibold text-ink">{fm(side.total)}</span> en
            total
            {side.overdue > 0 && (
              <>
                {' · '}
                <span className="tabular font-mono font-semibold text-rose">
                  {fm(side.overdue)}
                </span>{' '}
                vencido
              </>
            )}
          </>
        ) : undefined
      }
    >
      {side.parties.length === 0 && !extra ? (
        <p className="text-sm text-ink-muted">{empty}</p>
      ) : (
        <ul className="divide-y divide-border/70">
          {side.parties.map((p) => (
            <PartyRow key={p.name} party={p} fm={fm} />
          ))}
          {extra}
        </ul>
      )}
      <Link
        href={link.href}
        className="mt-3 inline-flex items-center gap-1 text-xs font-semibold text-primary hover:underline"
      >
        {link.label}
        <ArrowRight className="h-3.5 w-3.5" aria-hidden />
      </Link>
    </Section>
  );
}

function PartyRow({ party, fm }: { party: DueParty; fm: (n: number) => string }) {
  return (
    <li className="flex items-start justify-between gap-3 py-2.5">
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold text-ink">{party.name}</p>
        <p className="mt-0.5 text-micro text-ink-faint">
          {party.count} {party.count === 1 ? 'factura' : 'facturas'}
          {party.nextDue && (
            <>
              {' · '}
              {party.overdueDays ? 'la más vieja venció el ' : 'vence el '}
              <span className="tabular font-mono">{formatDay(party.nextDue)}</span>
            </>
          )}
        </p>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        <span className="tabular font-mono text-sm font-semibold text-ink">{fm(party.amount)}</span>
        {party.overdueDays ? (
          <span className={statusPill(party.overdueDays > 30 ? 'rose' : 'amber')}>
            {party.overdueDays} {party.overdueDays === 1 ? 'día' : 'días'} tarde
          </span>
        ) : null}
      </div>
    </li>
  );
}
