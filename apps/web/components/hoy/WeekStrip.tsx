import { DeltaPill } from '@/components/charts/DeltaPill';
import type { WeekCard } from '@/lib/hoy/insights';
import { formatCompactMoney, formatNumber } from '@cortex/agent-tools/src/format/display';
import { clsx } from 'clsx';
import Link from 'next/link';
import { SectionHead } from './SectionHead';

const TONE_BAR: Record<WeekCard['tone'], string> = {
  primary: 'bg-primary',
  emerald: 'bg-emerald',
  amber: 'bg-amber',
  sky: 'bg-sky',
  rose: 'bg-rose',
  ink: 'bg-ink-faint',
};

/**
 * «ESTA SEMANA»: CUATRO CIFRAS QUE SE LEEN DE UN VISTAZO.
 *
 * Lo vencido que te deben, lo que entra y lo que sale en los próximos 7 días y
 * cómo van las facturas ante la DIAN. Cada tarjeta es un enlace a su pantalla;
 * una raya del color de la cifra la ata a su gráfico, y la que pide atención
 * lleva un punto rosa (y lo dice con texto, no sólo con color). No lleva
 * funciones: las cifras son números y se escriben aquí.
 */
export function WeekStrip({ cards }: { cards: WeekCard[] }) {
  if (cards.length === 0) return null;
  return (
    <section aria-label="Esta semana" className="flex flex-col gap-3">
      <SectionHead title="Esta semana" hint="Lo que cobras, lo que pagas y lo que pide atención" />
      <ul className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        {cards.map((c) => {
          const text =
            c.fmt === 'money' ? formatCompactMoney(c.value, c.currency) : formatNumber(c.value, 0);
          return (
            <li key={c.id} className="min-w-0">
              <Link
                href={c.href}
                title={
                  c.fmt === 'money'
                    ? `${c.label}: ${formatCompactMoney(c.value, c.currency)}`
                    : undefined
                }
                className={clsx(
                  'group relative flex h-full flex-col gap-1.5 overflow-hidden rounded-card border bg-surface p-3 pl-4 transition-colors hover:border-border-strong focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary/40',
                  c.alert ? 'border-rose/40' : 'border-border',
                )}
              >
                <span
                  aria-hidden
                  className={clsx('absolute inset-y-0 left-0 w-1', TONE_BAR[c.tone])}
                />
                <span className="flex items-baseline gap-1.5 text-xs font-semibold text-ink-muted">
                  {c.alert && <span aria-hidden className="h-1.5 w-1.5 rounded-pill bg-rose" />}
                  <span className="min-w-0">{c.label}</span>
                  {c.alert && <span className="sr-only">(pide atención)</span>}
                </span>
                <span className="stat-display text-base leading-tight tabular-nums text-ink sm:text-lg">
                  {text}
                </span>
                <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-micro text-ink-faint">
                  {c.ratio !== null && <DeltaPill ratio={c.ratio} good={c.good} compact />}
                  <span>{c.hint}</span>
                </span>
                {c.ratio !== null && c.deltaLabel && (
                  <span className="text-micro text-ink-faint">{c.deltaLabel}</span>
                )}
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
