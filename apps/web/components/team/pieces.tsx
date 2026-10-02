import { Panel } from '@/components/ui/panel';
import type { Choice, ItemRowModel, MetricCell, OutputCell, WeekPoint } from '@/lib/team/screen';
import type { Trend } from '@/lib/team/shape';
import { clsx } from 'clsx';
import { ArrowDownRight, ArrowRight, ArrowUpRight, ExternalLink } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { MarkDoneButton } from './MarkDoneButton';
import type { TeamActions } from './types';

/**
 * Las piezas que comparten /team, /team/[persona] y «Mi semana»: el marco de
 * cada sección, las cápsulas, la cifra con su flecha (contra el propio
 * período anterior) y la mediana del equipo en voz baja, la lista de ítems y
 * las semanas en barras.
 */

export const pillLink =
  'inline-flex min-h-9 items-center justify-center gap-1.5 rounded-pill border border-border-strong bg-surface px-4 py-1.5 text-xs font-semibold text-ink transition-colors hover:bg-surface-2';

export const pillPrimary =
  'cortex-primary-button inline-flex min-h-9 items-center justify-center gap-1.5 rounded-pill bg-primary px-4 py-1.5 text-xs font-bold text-white transition-colors hover:bg-primary-strong disabled:cursor-not-allowed disabled:opacity-50';

export const pillQuiet =
  'inline-flex min-h-9 items-center justify-center gap-1.5 rounded-pill px-3 py-1.5 text-xs font-semibold text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink';

export const fieldClass =
  'min-h-10 w-full rounded-sm border border-border-strong bg-surface px-3 py-2 text-sm text-ink outline-none placeholder:text-ink-faint focus:border-primary focus:ring-2 focus:ring-primary/15';

const TONE_PILL = {
  neutral: 'border-border bg-surface-2 text-ink-muted',
  primary: 'border-primary/15 bg-primary-soft text-primary-ink',
  emerald: 'border-emerald/20 bg-emerald-soft text-emerald',
  amber: 'border-amber/20 bg-amber-soft text-amber',
  rose: 'border-rose/20 bg-rose-soft text-rose',
  sky: 'border-sky/20 bg-sky-soft text-sky',
} as const;

export type PillTone = keyof typeof TONE_PILL;

export function Pill({ tone = 'neutral', children }: { tone?: PillTone; children: ReactNode }) {
  return (
    <span
      className={clsx(
        'inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-pill border px-2.5 py-0.5 text-micro font-semibold',
        TONE_PILL[tone],
      )}
    >
      {children}
    </span>
  );
}

export function Section({
  id,
  title,
  subtitle,
  icon,
  right,
  children,
  className,
}: {
  id?: string;
  title: string;
  subtitle?: ReactNode;
  icon?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const headingId = id ? `${id}-titulo` : undefined;
  return (
    <section id={id} aria-labelledby={headingId} className={clsx('scroll-mt-6', className)}>
      <Panel className="h-full p-5 sm:p-6">
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            {icon && (
              <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-sm bg-primary-soft text-primary">
                {icon}
              </span>
            )}
            <div className="min-w-0">
              <h2 id={headingId} className="text-lg font-extrabold text-ink">
                {title}
              </h2>
              {subtitle && <p className="mt-0.5 text-xs text-ink-muted">{subtitle}</p>}
            </div>
          </div>
          {right && <div className="flex flex-wrap items-center gap-2">{right}</div>}
        </div>
        {children}
      </Panel>
    </section>
  );
}

/** Una fila de cápsulas que son enlaces: período, tipo de trabajo. */
export function ChoiceRow({ label, choices }: { label: string; choices: Choice[] }) {
  return (
    <nav aria-label={label} className="flex flex-wrap items-center gap-1.5">
      {choices.map((c) => (
        <Link
          key={c.key || 'todo'}
          href={c.href}
          aria-current={c.active ? 'page' : undefined}
          className={clsx(
            'rounded-pill border px-3 py-1.5 text-xs font-semibold transition-colors',
            c.active
              ? 'border-primary bg-primary-soft text-primary-ink'
              : 'border-border bg-surface text-ink-muted hover:border-border-strong hover:text-ink',
          )}
        >
          {c.label}
        </Link>
      ))}
    </nav>
  );
}

export function Avatar({ initials, size = 'md' }: { initials: string; size?: 'md' | 'lg' }) {
  return (
    <span
      aria-hidden
      className={clsx(
        'grid shrink-0 place-items-center rounded-pill bg-primary-soft font-bold text-primary-ink',
        size === 'lg' ? 'h-14 w-14 text-lg' : 'h-10 w-10 text-xs',
      )}
    >
      {initials}
    </span>
  );
}

const TREND_TONE = {
  good: 'text-emerald',
  attention: 'text-amber',
  neutral: 'text-ink-faint',
} as const;

const DIR_WORD = { up: 'subió', down: 'bajó', flat: 'igual' } as const;

/** La flecha contra su propio período anterior; el texto dice la cifra, el color sólo acompaña. */
export function TrendMark({ trend }: { trend: Trend | null }) {
  if (!trend) return null;
  const Icon =
    trend.dir === 'up' ? ArrowUpRight : trend.dir === 'down' ? ArrowDownRight : ArrowRight;
  return (
    <span className="inline-flex items-center gap-0.5 text-micro text-ink-faint">
      <Icon className={clsx('h-3.5 w-3.5', TREND_TONE[trend.tone])} aria-hidden />
      <span className="sr-only">{DIR_WORD[trend.dir]}, </span>
      <span className="tabular">{trend.before}</span>
    </span>
  );
}

/** Una cifra: nombre, valor, aclaración, flecha y la mediana del equipo en voz baja. */
export function MetricTile({ cell }: { cell: MetricCell }) {
  return (
    <div className="min-w-0 rounded-sm bg-surface-2/70 px-3 py-2.5">
      <p className="truncate text-micro font-semibold text-ink-muted" title={cell.label}>
        {cell.label}
      </p>
      <p
        className={clsx(
          'stat-num mt-0.5 text-lg font-bold',
          cell.attention ? 'text-rose' : 'text-ink',
        )}
      >
        {cell.value}
      </p>
      {cell.sub && <p className="tabular truncate text-micro text-ink-muted">{cell.sub}</p>}
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <TrendMark trend={cell.trend} />
        {cell.team && (
          <span
            className="tabular inline-flex items-center gap-1 text-micro text-ink-faint"
            title="Mediana del equipo en el mismo tipo de trabajo"
          >
            <span aria-hidden className="inline-block h-2.5 w-px bg-ink-faint/60" />
            equipo {cell.team}
          </span>
        )}
      </div>
    </div>
  );
}

export function OutputTile({ output }: { output: OutputCell[] }) {
  return (
    <div className="min-w-0 rounded-sm bg-surface-2/70 px-3 py-2.5">
      <p className="text-micro font-semibold text-ink-muted">Producido</p>
      {output.length === 0 ? (
        <p className="stat-num mt-0.5 text-lg font-bold text-ink-faint">—</p>
      ) : (
        output.slice(0, 2).map((o) => (
          <div key={o.unit} className="mt-0.5">
            <p className="stat-num truncate text-base font-bold text-ink" title={o.value}>
              {o.value}
            </p>
            <TrendMark trend={o.trend} />
          </div>
        ))
      )}
    </div>
  );
}

export function MetricGrid({
  metrics,
  output,
}: {
  metrics: MetricCell[];
  output: OutputCell[];
}) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {metrics.map((m) => (
        <MetricTile key={m.key} cell={m} />
      ))}
      <OutputTile output={output} />
    </div>
  );
}

/** La lista de ítems: lo vencido arriba, de dónde sale y, si se puede, «Marcar hecho». */
export function ItemList({
  items,
  showOwner,
  actions,
  empty,
}: {
  items: ItemRowModel[];
  showOwner?: boolean;
  actions?: Pick<TeamActions, 'markDone'> | null;
  empty?: string;
}) {
  if (!items.length)
    return <p className="text-sm text-ink-muted">{empty ?? 'No hay ítems abiertos.'}</p>;
  return (
    <ul className="divide-y divide-border">
      {items.map((i) => (
        <li key={i.id} className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 py-3">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-ink">
              {i.sourceHref ? (
                <Link href={i.sourceHref} className="hover:underline">
                  {i.title}
                </Link>
              ) : (
                i.title
              )}
            </p>
            <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-muted">
              <span>{i.workType}</span>
              {showOwner && (
                <>
                  <span aria-hidden>·</span>
                  <span>{i.owner ?? 'Sin responsable'}</span>
                </>
              )}
              {i.dueLabel && (
                <>
                  <span aria-hidden>·</span>
                  <span className={clsx('tabular', i.overdue && 'font-semibold text-rose')}>
                    {i.dueLabel}
                  </span>
                </>
              )}
              <span aria-hidden>·</span>
              <span className="tabular">
                {i.ageDays === 0 ? 'abierto hoy' : `abierto hace ${i.ageDays} d`}
              </span>
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {i.sourceHref ? (
              <Link
                href={i.sourceHref}
                className="inline-flex items-center gap-1 rounded-pill border border-border px-2.5 py-0.5 text-micro font-semibold text-ink-muted hover:text-ink"
              >
                {i.sourceLabel}
                <ExternalLink className="h-3 w-3" aria-hidden />
              </Link>
            ) : (
              <Pill>{i.sourceLabel}</Pill>
            )}
            {actions && i.canMarkDone && (
              <MarkDoneButton itemId={i.id} title={i.title} markDone={actions.markDone} />
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

/**
 * Las últimas semanas en barras: cerrados por semana (una sola medida, un
 * solo eje). La semana en curso va más clara: todavía no termina.
 */
export function WeekBars({ weeks, label }: { weeks: WeekPoint[]; label: string }) {
  const max = Math.max(1, ...weeks.map((w) => w.done));
  const W = 220;
  const H = 64;
  const gap = 6;
  const bw = (W - gap * (weeks.length - 1)) / weeks.length;
  const current = weeks.at(-1);
  return (
    <figure className="min-w-0">
      <svg
        viewBox={`0 0 ${W} ${H + 14}`}
        className="h-auto w-full max-w-[280px]"
        role="img"
        aria-label={`${label}: cerrados por semana, ${weeks.map((w) => `${w.label} ${w.done}`).join(', ')}`}
      >
        <line x1={0} x2={W} y1={H} y2={H} className="stroke-border" strokeWidth={1} />
        {weeks.map((w, k) => {
          const h = w.done === 0 ? 2 : Math.max(3, (w.done / max) * (H - 14));
          const x = k * (bw + gap);
          return (
            <g key={w.from}>
              <title>{`Semana del ${w.label}: ${w.done} cerrados, ${w.open} abiertos al cierre${w.current ? ' (en curso)' : ''}`}</title>
              <rect x={x - 2} y={0} width={bw + 4} height={H} className="fill-transparent" />
              <rect
                x={x}
                y={H - h}
                width={bw}
                height={h}
                rx={4}
                className={w.current ? 'fill-primary/40' : 'fill-primary'}
              />
              {(k === 0 || w.current) && (
                <text
                  x={k === 0 ? x : x + bw}
                  y={H + 11}
                  textAnchor={k === 0 ? 'start' : 'end'}
                  className="fill-ink-faint font-mono"
                  fontSize={9}
                >
                  {w.label}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <figcaption className="mt-1 text-micro text-ink-muted">
        Cerrados por semana · máx. <span className="tabular">{max}</span>
        {current ? (
          <>
            {' '}
            · esta semana <span className="tabular">{current.done}</span> (en curso)
          </>
        ) : null}
      </figcaption>
    </figure>
  );
}
