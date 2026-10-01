'use client';

import type { ComputedBlock, Tone } from '@cortex/agent-tools';
import { clsx } from 'clsx';
import { ArrowDownRight, ArrowRight, ArrowUpRight } from 'lucide-react';
import { Card, TONE_BAR, TONE_TEXT } from './theme';

/**
 * LA CIFRA, Y EL KPI CONTRA EL PERÍODO ANTERIOR.
 *
 * Sin `compare`, la cifra de siempre: el número grande, la meta si la hay y
 * cuántas filas lo sostienen. Con `compare`, el número es el del período
 * («Este mes»), con una flecha y el cambio contra el anterior, y una línea
 * pequeña con los últimos períodos.
 *
 * El color de la flecha dice si el cambio es BUENO, no hacia dónde va: subir
 * las ventas es verde, subir las devoluciones es rosa (`goodWhen`). Y nunca
 * sólo el color: la flecha, el signo y la frase dicen lo mismo para quien no
 * distingue verde de rosa.
 */

type Metric = Extract<ComputedBlock, { type: 'metric' }>;

const PERCENT = new Intl.NumberFormat('es-CO', { maximumFractionDigits: 1 });

export function MetricBlock({ block }: { block: Metric }) {
  const pct = block.goal ? Math.max(0, Math.min(block.goal.ratio, 1)) : 0;
  const compare = block.compare;
  return (
    <Card>
      <div className="flex items-baseline justify-between gap-2">
        <p className="field-label min-w-0">{block.title}</p>
        {compare && (
          <span className="shrink-0 text-micro text-ink-faint">{compare.currentLabel}</span>
        )}
      </div>
      <p
        className={clsx(
          'tabular mt-2 font-mono text-display font-semibold leading-none tracking-tight',
          TONE_TEXT[block.tone],
        )}
      >
        {block.display}
      </p>
      {compare && <Trend compare={compare} tone={block.tone} />}
      {block.goal ? (
        <div className="mt-4">
          <div className="h-1.5 overflow-hidden rounded-pill bg-surface-2">
            <div
              className={clsx(
                'h-full rounded-pill transition-[width] duration-500 ease-out',
                TONE_BAR[block.tone],
              )}
              style={{ width: `${pct * 100}%` }}
            />
          </div>
          <p className="mt-1.5 text-micro text-ink-faint">
            {Math.round(block.goal.ratio * 100)}% de la meta ·{' '}
            <span className="tabular font-mono">{block.goal.display}</span>
          </p>
        </div>
      ) : (
        !compare && (
          <p className="mt-3 text-micro text-ink-faint">
            {block.caption ??
              `${block.rows} ${block.rows === 1 ? 'fila' : 'filas'} · ${block.source}`}
          </p>
        )
      )}
      {compare && block.caption && (
        <p className="mt-2 text-micro text-ink-faint">{block.caption}</p>
      )}
    </Card>
  );
}

function Trend({ compare, tone }: { compare: NonNullable<Metric['compare']>; tone: Tone }) {
  const Arrow =
    compare.direction === 'up'
      ? ArrowUpRight
      : compare.direction === 'down'
        ? ArrowDownRight
        : ArrowRight;
  const color =
    compare.good === null
      ? 'bg-surface-2 text-ink-muted'
      : compare.good
        ? 'bg-emerald-soft text-emerald'
        : 'bg-rose-soft text-rose';
  const delta =
    compare.delta === null
      ? compare.direction === 'flat'
        ? 'igual'
        : 'nuevo'
      : `${compare.delta > 0 ? '+' : ''}${PERCENT.format(compare.delta * 100)} %`;
  return (
    <div className="mt-3 space-y-2">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-micro text-ink-faint">
        <span
          className={clsx(
            'tabular inline-flex items-center gap-0.5 rounded-pill px-1.5 py-0.5 font-mono font-semibold',
            color,
          )}
        >
          <Arrow className="h-3 w-3" aria-hidden />
          {delta}
        </span>
        <span>
          {compare.previousLabel}:{' '}
          <span className="tabular font-mono text-ink-muted">{compare.previousDisplay}</span>
        </span>
      </p>
      <Sparkline series={compare.series} tone={tone} />
    </div>
  );
}

/**
 * Una línea mínima, sin ejes: la forma de los últimos períodos. Es dibujo, no
 * dato — el lector de pantalla recibe la serie en texto.
 */
export function Sparkline({
  series,
  tone,
}: { series: Array<{ label: string; value: number }>; tone: Tone }) {
  if (series.length < 2) return null;
  const values = series.map((s) => s.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const W = 100;
  const H = 28;
  const pts = values.map((v, i) => {
    const x = (i / (values.length - 1)) * W;
    const y = H - 2 - ((v - min) / span) * (H - 4);
    return [x, y] as const;
  });
  const line = pts.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' ');
  return (
    <figure className={clsx('m-0', TONE_TEXT[tone])}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="h-8 w-full overflow-visible"
        aria-hidden="true"
      >
        <polygon points={`0,${H} ${line} ${W},${H}`} fill="currentColor" opacity={0.1} />
        <polyline
          points={line}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.75}
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <figcaption className="sr-only">
        {series.map((s) => `${s.label}: ${s.value}`).join('; ')}
      </figcaption>
    </figure>
  );
}
