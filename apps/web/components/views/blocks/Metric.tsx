'use client';

import type { ComputedBlock, Tone } from '@cortex/agent-tools';
import { clsx } from 'clsx';
import { ArrowDownRight, ArrowRight, ArrowUpRight, Target } from 'lucide-react';
import { useId } from 'react';
import { Card, TONE_BAR, TONE_COLOR, TONE_SOFT } from './theme';

/**
 * LA CIFRA, Y EL KPI CONTRA EL PERÍODO ANTERIOR.
 *
 * Sin `compare`, la cifra de siempre: el número grande, la meta si la hay y
 * cuántas filas lo sostienen. Con `compare`, el número es el del período
 * («Este mes»), con una ficha que dice el cambio contra el anterior y una
 * línea con los últimos períodos debajo — el único dato con tiempo que trae
 * una cifra, así que la línea sólo sale cuando lo hay.
 *
 * El número va en tinta, grande y monoespaciado: es lo que se lee primero y
 * tiene que leerse igual en cualquier marca. El tono del bloque marca el punto
 * del título, la línea y la barra de la meta.
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
  const long = block.display.length > 13;
  return (
    <Card className="flex flex-col">
      <div className="flex items-center justify-between gap-2">
        <p className="flex min-w-0 items-center gap-2 text-xs font-semibold text-ink-muted">
          <span
            aria-hidden
            className={clsx('h-2 w-2 shrink-0 rounded-pill', TONE_BAR[block.tone])}
          />
          <span className="truncate">{block.title}</span>
        </p>
        {compare && (
          <span className="shrink-0 rounded-pill bg-surface-2 px-2.5 py-0.5 text-micro font-semibold text-ink-muted">
            {compare.currentLabel}
          </span>
        )}
      </div>
      <p
        className={clsx(
          'tabular mt-3 font-mono font-semibold leading-none tracking-tight text-ink',
          long ? 'text-xl' : 'text-display',
        )}
      >
        {block.display}
      </p>
      {compare && <Trend compare={compare} />}
      {compare && compare.series.length >= 2 && (
        <div className="mt-auto pt-4">
          <Sparkline series={compare.series} tone={block.tone} />
        </div>
      )}
      {block.goal ? (
        <div className="mt-auto pt-5">
          <div className="mb-1.5 flex items-center justify-between gap-2 text-micro">
            <span className="inline-flex items-center gap-1 font-semibold text-ink-muted">
              <Target className="h-3.5 w-3.5" aria-hidden />
              {Math.round(block.goal.ratio * 100)} % de la meta
            </span>
            <span className="tabular font-mono text-ink-faint">{block.goal.display}</span>
          </div>
          {/* biome-ignore lint/a11y/useFocusableInteractive: una barra de avance se lee, no se usa. */}
          <div
            role="progressbar"
            aria-label={`${block.title}: avance hacia la meta`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(pct * 100)}
            className="h-2 overflow-hidden rounded-pill bg-surface-2"
          >
            <div
              className={clsx(
                'view-grow-x h-full rounded-pill',
                block.goal.ratio >= 1 ? 'bg-emerald' : TONE_BAR[block.tone],
              )}
              style={{ width: `${pct * 100}%` }}
            />
          </div>
        </div>
      ) : (
        !compare && (
          <p className="mt-auto pt-4 text-micro text-ink-faint">
            {block.caption ??
              `${block.rows} ${block.rows === 1 ? 'fila' : 'filas'} · ${block.source}`}
          </p>
        )
      )}
      {(compare || block.goal) && block.caption && (
        <p className="mt-2 text-micro leading-relaxed text-ink-faint">{block.caption}</p>
      )}
    </Card>
  );
}

function Trend({ compare }: { compare: NonNullable<Metric['compare']> }) {
  const Arrow =
    compare.direction === 'up'
      ? ArrowUpRight
      : compare.direction === 'down'
        ? ArrowDownRight
        : ArrowRight;
  const tone: Tone | null = compare.good === null ? null : compare.good ? 'emerald' : 'rose';
  const delta =
    compare.delta === null
      ? compare.direction === 'flat'
        ? 'igual'
        : 'nuevo'
      : `${compare.delta > 0 ? '+' : ''}${PERCENT.format(compare.delta * 100)} %`;
  return (
    <p className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-micro text-ink-faint">
      <span
        className={clsx(
          'tabular inline-flex items-center gap-0.5 rounded-pill py-0.5 pl-1.5 pr-2 font-mono font-semibold',
          tone ? TONE_SOFT[tone] : 'bg-surface-2 text-ink-muted',
        )}
      >
        <Arrow className="h-3.5 w-3.5" aria-hidden />
        {delta}
        {compare.good !== null && (
          <span className="sr-only">{compare.good ? ' (bien)' : ' (mal)'}</span>
        )}
      </span>
      <span>
        {compare.previousLabel}{' '}
        <span className="tabular font-mono text-ink-muted">{compare.previousDisplay}</span>
      </span>
    </p>
  );
}

/**
 * Una línea mínima, sin ejes: la forma de los últimos períodos, con el área
 * en degradado y el punto de hoy. Es dibujo, no dato — el lector de pantalla
 * recibe la serie en texto.
 */
export function Sparkline({
  series,
  tone,
}: { series: Array<{ label: string; value: number }>; tone: Tone }) {
  const gradient = `spark-${useId().replace(/:/g, '')}`;
  if (series.length < 2) return null;
  const values = series.map((s) => s.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const W = 100;
  const H = 36;
  const pts = values.map((v, i) => {
    const x = (i / (values.length - 1)) * W;
    const y = H - 3 - ((v - min) / span) * (H - 8);
    return [x, y] as const;
  });
  const line = pts.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' ');
  const last = pts[pts.length - 1] ?? [W, H / 2];
  const color = TONE_COLOR[tone];
  return (
    <figure className="relative m-0">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="h-10 w-full overflow-visible"
        aria-hidden="true"
      >
        <defs>
          <linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.28} />
            <stop offset="100%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>
        <polygon points={`0,${H} ${line} ${W},${H}`} fill={`url(#${gradient})`} />
        <polyline
          points={line}
          fill="none"
          stroke={color}
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      {/* El punto de hoy, en HTML para que no se deforme con el SVG estirado. */}
      <span
        aria-hidden
        className="absolute h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-pill border-2 border-surface"
        style={{
          left: `${(last[0] / W) * 100}%`,
          top: `${(last[1] / H) * 100}%`,
          background: color,
        }}
      />
      <figcaption className="mt-1 flex justify-between text-micro text-ink-faint">
        <span>{series[0]?.label}</span>
        <span>{series[series.length - 1]?.label}</span>
        <span className="sr-only">{series.map((s) => `${s.label}: ${s.value}`).join('; ')}</span>
      </figcaption>
    </figure>
  );
}
