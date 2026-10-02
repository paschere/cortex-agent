import type { ItemView } from '@/lib/autopilot/screen';
import { chipClass } from '@/lib/status-chip';
import { clsx } from 'clsx';
import {
  ArrowUpRight,
  BadgeCheck,
  CircleAlert,
  CircleHelp,
  Mail,
  ShieldCheck,
  Undo2,
} from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';

/**
 * Una cosa del día, en la línea de tiempo del piloto: qué vi (con cifras), qué
 * decidí y por qué, y qué pasó. Sin estado propio: la usan el ensayo (cliente)
 * y la corrida (servidor) por igual.
 */

const RAIL: Record<ItemView['statusTone'], string> = {
  neutral: 'bg-border-strong',
  primary: 'bg-primary',
  emerald: 'bg-emerald',
  amber: 'bg-amber',
  rose: 'bg-rose',
};

const VERIFY_TONE = {
  verified: 'emerald',
  not_verified: 'amber',
  unverifiable: 'neutral',
} as const;

export function ItemCard({ item, actions }: { item: ItemView; actions?: ReactNode }) {
  return (
    <li className="relative pl-6">
      <span
        aria-hidden
        className={clsx(
          'absolute left-0 top-2 h-2.5 w-2.5 rounded-full ring-4 ring-surface',
          RAIL[item.statusTone],
        )}
      />
      <div className="rounded-sm border border-border bg-surface p-4 transition-colors hover:border-border-strong">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className={chipClass('neutral')}>{item.areaLabel}</span>
          {item.statusLabel ? (
            <span className={chipClass(item.statusTone)}>{item.statusLabel}</span>
          ) : (
            <span className={chipClass(item.statusTone)}>{item.decisionLabel}</span>
          )}
          {item.amountLabel && (
            <span className="tabular ml-auto text-sm font-bold text-ink">{item.amountLabel}</span>
          )}
        </div>

        <h3 className="mt-2 text-sm font-bold leading-snug text-ink sm:text-base">{item.title}</h3>
        <p className="mt-1 text-sm leading-relaxed text-ink-muted">{item.why}</p>

        <p className="mt-2 flex items-start gap-1.5 text-xs leading-relaxed text-ink-faint">
          <CircleHelp className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>
            <span className="font-semibold text-ink-muted">Por qué {verb(item)}: </span>
            {item.reason}
            {item.authorityLabel && (
              <span className="ml-1 inline-flex items-center gap-1 font-semibold text-primary-ink">
                <ShieldCheck className="h-3 w-3" aria-hidden />
                {item.authorityLabel}
              </span>
            )}
          </span>
        </p>

        {item.preview && (
          <details className="group mt-3 rounded-sm border border-border bg-surface-2 px-3 py-2">
            <summary className="flex cursor-pointer list-none items-center gap-2 text-xs font-semibold text-ink-muted">
              <Mail className="h-3.5 w-3.5" aria-hidden />
              Correo a {item.preview.to}
              <span className="ml-auto text-ink-faint group-open:hidden">Ver texto</span>
            </summary>
            <p className="mt-2 text-xs font-semibold text-ink">{item.preview.subject}</p>
            <pre className="mt-1 whitespace-pre-wrap font-sans text-xs leading-relaxed text-ink-muted">
              {item.preview.body}
            </pre>
          </details>
        )}

        {item.resultSummary && (
          <div className="mt-3 rounded-sm border border-emerald/20 bg-emerald-soft px-3 py-2 text-xs leading-relaxed text-ink">
            <p className="flex items-start gap-1.5">
              <BadgeCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald" aria-hidden />
              <span>{item.resultSummary}</span>
            </p>
            {item.verification && item.verificationLabel && (
              <p className="mt-1.5">
                <span className={chipClass(VERIFY_TONE[item.verification])}>
                  {item.verificationLabel}
                </span>
              </p>
            )}
          </div>
        )}

        {item.error && (
          <p className="mt-3 flex items-start gap-1.5 rounded-sm border border-rose/20 bg-rose-soft px-3 py-2 text-xs leading-relaxed text-rose">
            <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            <span>{item.error}</span>
          </p>
        )}

        {(item.href || item.undo || item.approvalsHref || actions) && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {actions}
            {item.approvalsHref && (
              <Link
                href={item.approvalsHref}
                className="cortex-primary-button inline-flex min-h-9 items-center gap-1.5 rounded-pill bg-primary px-4 py-1.5 text-xs font-bold text-white hover:bg-primary-strong"
              >
                <Mail className="h-3.5 w-3.5" aria-hidden />
                Revisar y aprobar el correo
              </Link>
            )}
            {item.undo && (
              <Link
                href={item.undo.href}
                className="inline-flex min-h-9 items-center gap-1.5 rounded-pill border border-border-strong bg-surface px-3 py-1.5 text-xs font-semibold text-ink hover:bg-surface-2"
              >
                <Undo2 className="h-3.5 w-3.5" aria-hidden />
                {item.undo.label}
              </Link>
            )}
            {item.href && (
              <Link
                href={item.href}
                className="inline-flex min-h-9 items-center gap-1 rounded-pill px-3 py-1.5 text-xs font-semibold text-ink-muted hover:bg-surface-2 hover:text-ink"
              >
                Ver de dónde sale
                <ArrowUpRight className="h-3.5 w-3.5" aria-hidden />
              </Link>
            )}
          </div>
        )}
      </div>
    </li>
  );
}

function verb(item: ItemView): string {
  if (item.decision === 'do')
    return item.status === 'failed' || item.status === 'skipped'
      ? 'lo iba a hacer'
      : item.status
        ? 'lo hice'
        : 'lo haría';
  if (item.decision === 'ask') return 'te pregunto';
  return 'sólo te lo cuento';
}

/** Una lista de cosas con su riel. */
export function ItemList({ children }: { children: ReactNode }) {
  return (
    <ul className="relative space-y-3 before:absolute before:bottom-2 before:left-[4px] before:top-2 before:w-px before:bg-border">
      {children}
    </ul>
  );
}
