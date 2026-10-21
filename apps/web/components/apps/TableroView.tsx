'use client';

import { formatMoney, formatNumber } from '@cortex/agent-tools/src/format/display';

import type { ComputedTablero, ComputedWidget } from '@cortex/agent-tools';
import { clsx } from 'clsx';
import { AlertTriangle, ArrowUpRight, CheckCircle2 } from 'lucide-react';
import Link from 'next/link';
import { DeltaPill } from '../charts/DeltaPill';
import { MetricChart } from '../charts/MetricChart';
import { RankBars } from '../charts/RankBars';
import { SegmentBar } from '../charts/SegmentBar';
import { Sparkline } from '../charts/Sparkline';
import { CHART_COLOR, type ChartTone } from '../charts/colors';
import type { MetricModel } from '../charts/metric-types';

/**
 * UN TABLERO DE UNA APP (0225): cifras con su micrográfico y su cambio,
 * gráficos con rangos/comparar/zoom y registros al tocar un punto, reparto por
 * estado, ranking y «mis pendientes». Todo llega YA calculado con el rol y el
 * scope de filas de quien mira (computeTablero): aquí sólo se pinta. Un widget
 * que el rol no puede leer no llega, así que no hay huecos ni títulos huérfanos.
 */

const SPAN: Record<'full' | 'half' | 'third', string> = {
  full: 'md:col-span-6',
  half: 'md:col-span-3',
  third: 'md:col-span-2',
};

const CARD = 'rounded-card border border-border bg-surface p-4 shadow-card';

function Frame({
  w,
  children,
  action,
}: {
  w: ComputedWidget;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <section className={clsx(CARD, 'min-w-0', SPAN[w.width])} aria-label={w.title}>
      <header className="mb-3 flex items-start justify-between gap-2">
        <h3 className="text-sm font-semibold text-ink-muted">{w.title}</h3>
        {action ??
          (w.href && (
            <Link
              href={w.href}
              className="inline-flex shrink-0 items-center gap-0.5 text-xs font-semibold text-primary hover:underline"
            >
              Ver <ArrowUpRight className="h-3 w-3" aria-hidden />
            </Link>
          ))}
      </header>
      {children}
    </section>
  );
}

function Kpi({ w }: { w: Extract<ComputedWidget, { kind: 'kpi' }> }) {
  const color = CHART_COLOR[w.tone as ChartTone];
  const good =
    w.deltaRatio === null || Math.abs(w.deltaRatio) < 0.005
      ? null
      : w.deltaRatio >= 0 === w.goodWhenUp;
  const body = (
    <>
      <div className="flex items-end justify-between gap-3">
        <span
          className="stat-display truncate text-[2.1rem] leading-none text-ink"
          aria-live="polite"
        >
          {w.display}
        </span>
        {w.series.length > 1 && (
          <Sparkline
            values={w.series}
            labels={w.labels}
            color={color}
            height={40}
            name={w.title}
            format={(n) => (w.format === 'money' ? formatMoney(n) : formatNumber(n))}
            className="h-10 w-24 shrink-0"
          />
        )}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1">
        {w.hasDelta && (
          <DeltaPill ratio={w.deltaRatio} good={good} label={w.periodLabel ?? undefined} compact />
        )}
        {w.goal && (
          <span
            className={clsx(
              'inline-flex items-center gap-1 text-micro font-semibold',
              w.goal.reached ? 'text-emerald' : 'text-amber',
            )}
          >
            {w.goal.reached ? (
              <CheckCircle2 className="h-3 w-3" aria-hidden />
            ) : (
              <AlertTriangle className="h-3 w-3" aria-hidden />
            )}
            Meta {w.goal.display}
          </span>
        )}
      </div>
    </>
  );
  return (
    <section
      className={clsx(
        CARD,
        'min-w-0 transition-colors',
        SPAN[w.width],
        w.href && 'hover:border-primary/40',
      )}
      aria-label={w.title}
    >
      <h3 className="mb-2 text-sm font-semibold text-ink-muted">
        {w.href ? (
          <Link href={w.href} className="hover:text-primary">
            {w.title}
          </Link>
        ) : (
          w.title
        )}
      </h3>
      {body}
    </section>
  );
}

function Widget({ w, today }: { w: ComputedWidget; today: string }) {
  switch (w.kind) {
    case 'kpi':
      return <Kpi w={w} />;
    case 'chart':
      return (
        <Frame w={w} action={<span />}>
          <MetricChart
            metric={w.metric as unknown as MetricModel}
            today={today}
            height={240}
            renderHeader={(info) => (
              <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-1">
                <span className="stat-display text-[2rem] leading-none text-ink">
                  {info.summary.current === null
                    ? '—'
                    : w.metric.fmt === 'money'
                      ? formatMoney(info.summary.current)
                      : formatNumber(info.summary.current, 0)}
                </span>
                <DeltaPill
                  ratio={info.summary.ratio}
                  good={
                    info.summary.ratio === null || Math.abs(info.summary.ratio) < 0.005
                      ? null
                      : info.summary.ratio >= 0 === w.metric.goodWhenUp
                  }
                  label="vs. el período anterior"
                  compact
                />
              </div>
            )}
          />
        </Frame>
      );
    case 'status':
      return (
        <Frame w={w}>
          <SegmentBar
            name={w.title}
            total={String(w.total)}
            totalLabel="Registros"
            items={w.segments.map((s) => ({
              key: s.key,
              label: s.label,
              value: s.value,
              display: formatNumber(s.value, 0),
              color: CHART_COLOR[s.tone as ChartTone],
            }))}
          />
        </Frame>
      );
    case 'ranking':
      return (
        <Frame w={w}>
          <RankBars
            name={w.title}
            color={CHART_COLOR[w.tone as ChartTone]}
            items={w.items.map((i) => ({ label: i.label, value: i.value, display: i.display }))}
          />
        </Frame>
      );
    case 'pending':
      return (
        <Frame w={w}>
          {w.items.length === 0 ? (
            <p className="flex items-center gap-2 py-4 text-sm text-ink-muted">
              <CheckCircle2 className="h-4 w-4 text-emerald" aria-hidden /> {w.emptyText}
            </p>
          ) : (
            <>
              <ul className="divide-y divide-border">
                {w.items.map((i) => {
                  const inner = (
                    <>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-semibold text-ink">
                          {i.title}
                        </span>
                        {i.subtitle && (
                          <span className="block truncate text-xs text-ink-muted">
                            {i.subtitle}
                          </span>
                        )}
                      </span>
                      {i.due && (
                        <span
                          className={clsx(
                            'shrink-0 rounded-pill px-2 py-0.5 text-micro font-semibold',
                            i.overdue ? 'bg-rose-soft text-rose' : 'bg-surface-2 text-ink-muted',
                          )}
                        >
                          {i.overdue ? 'Atrasado · ' : ''}
                          {i.due}
                        </span>
                      )}
                    </>
                  );
                  return (
                    <li key={i.id}>
                      {i.href ? (
                        <Link
                          href={i.href}
                          className="flex min-h-11 items-center gap-3 py-2 hover:bg-surface-2"
                        >
                          {inner}
                        </Link>
                      ) : (
                        <div className="flex min-h-11 items-center gap-3 py-2">{inner}</div>
                      )}
                    </li>
                  );
                })}
              </ul>
              {w.total > w.items.length && (
                <p className="mt-2 text-xs text-ink-faint">y {w.total - w.items.length} más</p>
              )}
            </>
          )}
        </Frame>
      );
  }
}

export function TableroView({ tablero }: { tablero: ComputedTablero }) {
  return (
    <div className="space-y-4">
      <header>
        <h2 className="text-xl font-semibold tracking-tight text-ink">{tablero.title}</h2>
        {tablero.description && (
          <p className="mt-0.5 text-sm text-ink-muted">{tablero.description}</p>
        )}
      </header>
      {tablero.widgets.length === 0 ? (
        <p className="rounded-card border border-dashed border-border-strong bg-surface px-4 py-8 text-center text-sm text-ink-muted">
          Este tablero todavía no tiene nada que tu rol pueda ver.
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-6">
          {tablero.widgets.map((w) => (
            <Widget key={w.id} w={w} today={tablero.today} />
          ))}
        </div>
      )}
    </div>
  );
}
