'use client';

import type { ComputedBlock } from '@cortex/agent-tools';
import { clsx } from 'clsx';
import { Target } from 'lucide-react';
import { DeltaPill } from '../../charts/DeltaPill';
import { Sparkline } from '../../charts/Sparkline';
import { axisFormatterFor } from '../../charts/scales';
import { EMPHASIS_SCALE } from '@/lib/views/block-design';
import { Glyph } from '../../apps/AppGlyph';
import { useBlockDesign, useVariant } from './design';
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

const STATUS_TONE = { good: 'emerald', warn: 'amber', bad: 'rose' } as const;
const STATUS_TEXT = { good: 'En meta', warn: 'Cerca', bad: 'Lejos' } as const;

const STATUS_TEXT_DOWN = {
  good: 'Bajo el tope',
  warn: 'Pasó el tope',
  bad: 'Muy sobre el tope',
} as const;

const PERCENT = new Intl.NumberFormat('es-CO', { maximumFractionDigits: 1 });

export function MetricBlock({ block }: { block: Metric }) {
  const variant = useVariant();
  const { design } = useBlockDesign();
  const scale = EMPHASIS_SCALE[design?.emphasis ?? 'normal'];
  const hiddenTitle = design?.title === 'hidden';
  const hasGoal = !!block.goal;
  const hasCompare = !!block.compare;
  const hasSeries = (block.compare?.series.length ?? 0) >= 2;
  // Lo que no se puede dibujar sin datos vuelve a la cifra de siempre.
  const shape =
    variant === 'ring' && hasGoal
      ? 'ring'
      : variant === 'compare' && hasCompare
        ? 'compare'
        : variant === 'split' && (hasGoal || hasCompare)
          ? 'split'
          : variant === 'number-sparkline'
            ? 'spark'
            : 'number';
  const pct = block.goal ? Math.max(0, Math.min(block.goal.ratio, 1)) : 0;
  const compare = block.compare;
  // El semáforo sólo existe con meta: verde, ámbar o rojo, y siempre con texto.
  const status = block.goal?.status ?? null;
  // El tamaño sigue el ANCHO DE LA TARJETA, no la longitud del texto sola: una
  // cifra como «$ 168.200.000» cabe en media fila pero no en un tercio de un
  // teléfono. La tarjeta es contenedor (`container-type`) y la cifra toma lo
  // que quepa: la mono mide ~0,6 em por carácter, así que 150/largo en `cqi`
  // la deja dentro con margen, entre 1 rem y el tamaño de titular.
  // El énfasis achica o agranda el techo; el ancho de la tarjeta sigue mandando.
  const cq = Math.max(4, Math.floor(150 / Math.max(block.display.length, 1)));
  const fit = `clamp(1rem, ${scale < 1 ? Math.round(cq * scale) : cq}cqi, ${(2.25 * scale).toFixed(2)}rem)`;
  return (
    <Card className="flex flex-col">
      <div className="flex items-center justify-between gap-2">
        <p className="flex min-w-0 items-center gap-2 text-xs font-semibold text-ink-muted">
          <span
            aria-hidden
            className={clsx('h-2 w-2 shrink-0 rounded-pill', TONE_BAR[block.tone])}
          />
          {design?.icon && (
            <span aria-hidden className="shrink-0 text-ink-muted">
              <Glyph name={design.icon} className="h-4 w-4" />
            </span>
          )}
          <span className={clsx('truncate', hiddenTitle && 'sr-only')}>{block.title}</span>
        </p>
        {compare && (
          <span className="shrink-0 rounded-pill bg-surface-2 px-2.5 py-0.5 text-micro font-semibold text-ink-muted">
            {compare.currentLabel}
          </span>
        )}
      </div>
      {shape !== 'ring' && shape !== 'split' && (
        <div className="mt-3" style={{ containerType: 'inline-size' }}>
          <p
            className="tabular whitespace-nowrap tabular-nums font-semibold leading-none tracking-tight text-ink"
            style={{ fontSize: fit }}
          >
            {block.display}
          </p>
        </div>
      )}
      {shape === 'ring' && block.goal && <RingBody block={block} goal={block.goal} />}
      {shape === 'compare' && compare && <CompareBody compare={compare} />}
      {shape === 'split' && <SplitBody block={block} />}
      {(shape === 'number' || shape === 'spark') && compare && <Trend compare={compare} />}
      {(shape === 'number' || shape === 'spark') && compare && compare.series.length >= 2 && (
        <div className="mt-auto pt-4">
          <Sparkline
            values={compare.series.map((x) => x.value)}
            labels={compare.series.map((x) => x.label)}
            color={TONE_COLOR[block.tone]}
            format={axisFormatterFor(block.display)}
            name={block.title}
            height={shape === 'spark' ? 72 : 40}
            showLabels
          />
        </div>
      )}
      {shape === 'ring' || shape === 'split' ? null : block.goal ? (
        <div className="mt-auto pt-5">
          <div className="mb-1.5 flex items-center justify-between gap-2 text-micro">
            <span className="inline-flex flex-wrap items-center gap-1.5 font-semibold text-ink-muted">
              <span className="inline-flex items-center gap-1">
                <Target className="h-3.5 w-3.5" aria-hidden />
                {Math.round(block.goal.ratio * 100)} %{' '}
                {block.goal.direction === 'down' ? 'del tope' : 'de la meta'}
              </span>
              {status && (
                <span
                  className={clsx(
                    'inline-flex items-center gap-1 rounded-pill px-2 py-0.5',
                    TONE_SOFT[STATUS_TONE[status]],
                  )}
                >
                  <span
                    aria-hidden
                    className={clsx('h-1.5 w-1.5 rounded-pill', TONE_BAR[STATUS_TONE[status]])}
                  />
                  {block.goal?.direction === 'down'
                    ? STATUS_TEXT_DOWN[status]
                    : STATUS_TEXT[status]}
                </span>
              )}
            </span>
            <span className="tabular tabular-nums text-ink-faint">{block.goal.display}</span>
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
                status ? TONE_BAR[STATUS_TONE[status]] : TONE_BAR[block.tone],
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
  const delta =
    compare.delta === null
      ? compare.direction === 'flat'
        ? 'igual'
        : 'nuevo'
      : `${compare.delta > 0 ? '+' : ''}${PERCENT.format(compare.delta * 100)} %`;
  return (
    <p className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-micro text-ink-faint">
      <DeltaPill
        ratio={compare.delta === null ? (compare.direction === 'flat' ? 0 : null) : compare.delta}
        good={compare.good}
        text={delta.replace('-', '−')}
      />
      <span>
        {compare.previousLabel}{' '}
        <span className="tabular tabular-nums text-ink-muted">{compare.previousDisplay}</span>
      </span>
    </p>
  );
}

type Goal = NonNullable<Metric['goal']>;

/** ANILLO: el avance a la meta con la cifra al centro; el % y la frase debajo. */
function RingBody({ block, goal }: { block: Metric; goal: Goal }) {
  const { design } = useBlockDesign();
  const scale = EMPHASIS_SCALE[design?.emphasis ?? 'normal'];
  const status = goal.status ?? null;
  const tone = status ? STATUS_TONE[status] : block.tone;
  const pct = Math.max(0, Math.min(goal.ratio, 1));
  const R = 44;
  const C = 2 * Math.PI * R;
  const real = Math.round(goal.ratio * 100);
  const phrase = goal.direction === 'down' ? 'del tope' : 'de la meta';
  const cq = Math.max(8, Math.floor(130 / Math.max(block.display.length, 1)));
  return (
    <div className="mt-3 flex flex-col items-center gap-3 text-center">
      {/* biome-ignore lint/a11y/useFocusableInteractive: un anillo de avance se lee, no se usa. */}
      <div
        role="progressbar"
        aria-label={`${block.title}: avance hacia la meta`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(pct * 100)}
        aria-valuetext={`${block.display}, ${real} % ${phrase}`}
        className="relative aspect-square max-w-full"
        style={{ width: `${Math.round(152 * Math.min(scale, 1.1))}px` }}
      >
        <svg viewBox="0 0 100 100" className="h-full w-full -rotate-90" aria-hidden>
          <circle cx={50} cy={50} r={R} fill="none" className="stroke-surface-2" strokeWidth={9} />
          <circle
            cx={50}
            cy={50}
            r={R}
            fill="none"
            stroke={TONE_COLOR[tone]}
            strokeWidth={9}
            strokeLinecap="round"
            opacity={pct <= 0 ? 0 : 1}
            strokeDasharray={`${pct * C} ${C}`}
          />
        </svg>
        <div
          className="absolute inset-[16%] grid place-items-center"
          style={{ containerType: 'inline-size' }}
        >
          <p
            className="tabular whitespace-nowrap tabular-nums font-semibold leading-none tracking-tight text-ink"
            style={{ fontSize: `clamp(0.75rem, ${cq}cqi, ${(1.5 * scale).toFixed(2)}rem)` }}
          >
            {block.display}
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-micro font-semibold text-ink-muted">
        <span className="inline-flex items-center gap-1">
          <Target className="h-3.5 w-3.5" aria-hidden />
          {real} % {phrase}
        </span>
        {status && (
          <span
            className={clsx(
              'inline-flex items-center gap-1 rounded-pill px-2 py-0.5',
              TONE_SOFT[STATUS_TONE[status]],
            )}
          >
            {goal.direction === 'down' ? STATUS_TEXT_DOWN[status] : STATUS_TEXT[status]}
          </span>
        )}
      </div>
      <p className="tabular tabular-nums text-micro text-ink-faint">
        {goal.direction === 'down' ? 'Tope' : 'Meta'}: {goal.display}
      </p>
    </div>
  );
}

/** COMPARAR: la cifra y, bien a la vista, la flecha y el % contra el período anterior. */
function CompareBody({ compare }: { compare: NonNullable<Metric['compare']> }) {
  const { design } = useBlockDesign();
  const scale = EMPHASIS_SCALE[design?.emphasis ?? 'normal'];
  const ratio =
    compare.delta === null ? (compare.direction === 'flat' ? 0 : null) : compare.delta;
  const arrow = compare.direction === 'up' ? '▲' : compare.direction === 'down' ? '▼' : '■';
  const text =
    compare.delta === null
      ? compare.direction === 'flat'
        ? 'igual'
        : 'nuevo'
      : `${compare.delta > 0 ? '+' : ''}${PERCENT.format(compare.delta * 100)} %`;
  const tone =
    compare.good === null || compare.good === undefined || ratio === null || ratio === 0
      ? 'bg-surface-2 text-ink-muted'
      : compare.good
        ? 'bg-emerald-soft text-emerald'
        : 'bg-rose-soft text-rose';
  return (
    <div className="mt-3 flex flex-col gap-2">
      <p
        className={clsx(
          'tabular inline-flex w-fit max-w-full items-center gap-2 rounded-card px-3 py-1.5 tabular-nums font-semibold leading-none',
          tone,
        )}
        style={{ fontSize: `${(1.25 * scale).toFixed(2)}rem` }}
      >
        <span aria-hidden className="text-sm leading-none">
          {arrow}
        </span>
        <span>{text.replace('-', '−')}</span>
        {compare.good !== null && compare.good !== undefined && ratio !== 0 && (
          <span className="sr-only">{compare.good ? ' (bien)' : ' (mal)'}</span>
        )}
      </p>
      <p className="text-micro text-ink-faint">
        Contra {compare.previousLabel.toLowerCase()}{' '}
        <span className="tabular tabular-nums font-semibold text-ink-muted">
          {compare.previousDisplay}
        </span>
      </p>
    </div>
  );
}

/** DOS CIFRAS: la actual y la meta (o, sin meta, la del período anterior), con rótulos. */
function SplitBody({ block }: { block: Metric }) {
  const { design } = useBlockDesign();
  const scale = EMPHASIS_SCALE[design?.emphasis ?? 'normal'];
  const other = block.goal
    ? {
        label: block.goal.direction === 'down' ? 'Tope' : 'Meta',
        display: block.goal.display,
        note: `${Math.round(block.goal.ratio * 100)} % ${block.goal.direction === 'down' ? 'del tope' : 'de la meta'}`,
      }
    : block.compare
      ? {
          label: block.compare.previousLabel,
          display: block.compare.previousDisplay,
          note: null,
        }
      : null;
  if (!other) return null;
  const now = block.compare?.currentLabel ?? 'Ahora';
  const longest = Math.max(block.display.length, other.display.length, 1);
  const cq = Math.max(8, Math.floor(110 / longest));
  const size = `clamp(0.875rem, ${cq}cqi, ${(1.75 * scale).toFixed(2)}rem)`;
  return (
    <div className="mt-3 grid grid-cols-2 gap-3">
      {[
        { label: now, display: block.display, strong: true, note: null },
        { label: other.label, display: other.display, strong: false, note: other.note },
      ].map((c) => (
        <div
          key={c.label}
          className="min-w-0"
          style={{ containerType: 'inline-size' }}
        >
          <p className="truncate text-micro font-semibold text-ink-muted">{c.label}</p>
          <p
            className={clsx(
              'tabular mt-1 whitespace-nowrap tabular-nums font-semibold leading-none tracking-tight',
              c.strong ? 'text-ink' : 'text-ink-muted',
            )}
            style={{ fontSize: size }}
          >
            {c.display}
          </p>
          {c.note && <p className="mt-1.5 text-micro text-ink-faint">{c.note}</p>}
        </div>
      ))}
    </div>
  );
}
