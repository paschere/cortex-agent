'use client';

import { clsx } from 'clsx';
import { useId, useMemo, useState } from 'react';
import { SURFACE } from './colors';
import { areaPath, describeTrend, formatCompact, monotonePath } from './scales';

const W = 100;

/**
 * La línea mínima de una tarjeta de cifra: curva suave, degradado debajo y el
 * punto de hoy con su halo. Sin ejes. Al pasar el puntero (o tocar) marca el
 * período y su valor. Con un solo dato o todo igual, una línea plana apagada.
 */
export function Sparkline({
  values,
  labels,
  color,
  height = 40,
  format = (n) => formatCompact(n),
  name = 'Serie',
  className,
  showLabels = false,
}: {
  values: number[];
  /** Rótulo de cada valor (para la ficha y el texto accesible). */
  labels?: string[];
  color: string;
  height?: number;
  format?: (n: number) => string;
  name?: string;
  className?: string;
  /** Primer y último rótulo bajo la línea. */
  showLabels?: boolean;
}) {
  const gradient = `spark-${useId().replace(/:/g, '')}`;
  const [active, setActive] = useState<number | null>(null);
  const n = values.length;
  const geo = useMemo(() => {
    if (n === 0) return null;
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min;
    const H = height;
    const top = 5;
    const bottom = H - 4;
    const pts = values.map((v, i) => ({
      x: n === 1 ? W / 2 : (i / (n - 1)) * W,
      y: span === 0 ? (top + bottom) / 2 : bottom - ((v - min) / span) * (bottom - top),
    }));
    return { pts, flat: span === 0, H };
  }, [values, n, height]);
  if (!geo) return null;
  const { pts, flat, H } = geo;
  const lastIdx = n - 1;
  const last = pts[lastIdx] as { x: number; y: number };
  const lab = (i: number) => labels?.[i] ?? `${i + 1}`;
  const shown = active ?? lastIdx;
  const sp = pts[shown] as { x: number; y: number };
  const insufficient = n < 2 || flat;
  const text =
    n < 2
      ? `${name}: ${format(values[0] ?? 0)}. Sin datos suficientes para una tendencia.`
      : describeTrend({ name, labels: values.map((_, i) => lab(i)), values, format });

  return (
    <figure className={clsx('relative m-0', className)}>
      <div
        className="relative"
        style={{ height, touchAction: 'pan-y' }}
        role="img"
        aria-label={text}
        onPointerMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setActive(
            Math.min(n - 1, Math.max(0, Math.round(((e.clientX - r.left) / r.width) * (n - 1)))),
          );
        }}
        onPointerLeave={(e) => {
          if (e.pointerType === 'mouse') setActive(null);
        }}
        onPointerDown={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setActive(
            Math.min(n - 1, Math.max(0, Math.round(((e.clientX - r.left) / r.width) * (n - 1)))),
          );
        }}
      >
        <svg
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          className="absolute inset-0 h-full w-full overflow-visible"
          aria-hidden="true"
        >
          <defs>
            <linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.3} />
              <stop offset="100%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          {!insufficient && (
            <path d={areaPath(pts, H)} fill={`url(#${gradient})`} className="cx-fade" />
          )}
          {n >= 2 && (
            <path
              d={monotonePath(pts)}
              pathLength={1}
              fill="none"
              stroke={color}
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
              opacity={insufficient ? 0.45 : 1}
              className={insufficient ? undefined : 'cx-draw'}
              strokeDasharray={insufficient ? '4 4' : undefined}
            />
          )}
        </svg>
        {/* Los puntos, en HTML para que no se deformen con el SVG estirado. */}
        {active === null && !insufficient && (
          <span
            aria-hidden
            className="pointer-events-none absolute h-5 w-5 -translate-x-1/2 -translate-y-1/2 rounded-pill"
            style={{ left: `${last.x}%`, top: last.y, background: color, opacity: 0.18 }}
          />
        )}
        <span
          aria-hidden
          className="pointer-events-none absolute h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-pill"
          style={{
            left: `${sp.x}%`,
            top: sp.y,
            background: color,
            boxShadow: `0 0 0 2px ${SURFACE}`,
            opacity: insufficient ? 0.6 : 1,
          }}
        />
        {active !== null && n >= 2 && (
          <span
            aria-hidden
            className="tabular pointer-events-none absolute z-10 -translate-x-1/2 whitespace-nowrap rounded-sm border border-border bg-surface px-2 py-1 tabular-nums text-micro text-ink shadow-pop"
            style={{
              left: `${Math.min(Math.max(sp.x, 22), 78)}%`,
              top: Math.max(sp.y - 34, -34),
            }}
          >
            <span className="text-ink-faint">{lab(active)} </span>
            <span className="font-semibold">{format(values[active] ?? 0)}</span>
          </span>
        )}
      </div>
      {showLabels && n >= 2 && (
        <figcaption aria-hidden className="mt-1 flex justify-between text-micro text-ink-faint">
          <span>{lab(0)}</span>
          <span>{lab(lastIdx)}</span>
        </figcaption>
      )}
      {insufficient && n >= 1 && (
        <p className="sr-only">Sin datos suficientes para una tendencia.</p>
      )}
    </figure>
  );
}
