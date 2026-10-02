'use client';

import type { ComputedBlock } from '@cortex/agent-tools';
import { clsx } from 'clsx';
import { BarChart3 } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import { useViewBrand } from './blocks/brand';
import { EmptyState, TONE_COLOR, seriesColors } from './blocks/theme';

/**
 * Los tres gráficos de una vista, en SVG y HTML a mano.
 *
 * No hay librería de gráficos en la app (los informes también dibujan su SVG,
 * ver reports/charts.ts) y para tres formas no hacía falta traer una. El color
 * sale de variables —`--view-fill` es el color de la marca para dibujar, ver
 * views.css— así que el mismo gráfico se ve bien en el tema oscuro de la app,
 * en el claro del enlace público y con la marca de cada empresa sin saber en
 * cuál está.
 *
 *   - Barras: horizontales, porque las categorías tienen nombres largos y en
 *     un teléfono una columna vertical no deja leerlos.
 *   - Línea: con rejilla suave, eje con cifras compactas y una guía que sigue
 *     al puntero (o a las flechas del teclado) con el valor de ese punto.
 *   - Dona: con el total en el centro; pasar por un trozo o por su fila de la
 *     leyenda lo resalta y pone su cifra en el centro.
 *
 * Cada gráfico lleva sus valores en texto (leyenda, lista o `sr-only`): un
 * gráfico es un dibujo de números y los números tienen que poder leerse,
 * copiarse y pasar por un lector de pantalla.
 */

type Chart = Extract<ComputedBlock, { type: 'chart' }>;

export function ViewChart({ block }: { block: Chart }) {
  if (block.points.length === 0) {
    return (
      <EmptyState
        icon={<BarChart3 className="h-5 w-5" aria-hidden />}
        title="No hay filas que dibujar"
        hint="Cuando entren datos que cumplan los filtros, el gráfico aparece solo."
      />
    );
  }
  if (block.chart === 'donut') return <Donut block={block} />;
  if (block.chart === 'line') return <Line block={block} />;
  return <Bars block={block} />;
}

const SHARE = new Intl.NumberFormat('es-CO', { maximumFractionDigits: 0 });

function Bars({ block }: { block: Chart }) {
  const max = Math.max(...block.points.map((p) => Math.abs(p.value)), 1);
  const sum = block.points.reduce((a, p) => a + Math.max(p.value, 0), 0) || 1;
  const color = TONE_COLOR[block.tone];
  return (
    <ul className="space-y-3.5" aria-label={block.title}>
      {block.points.map((p, i) => (
        <li key={p.label} title={`${p.label}: ${p.display}`}>
          <div className="mb-1.5 flex items-baseline justify-between gap-3 text-xs">
            <span className="min-w-0 truncate font-medium text-ink">{p.label}</span>
            <span className="shrink-0">
              <span className="tabular font-mono font-semibold text-ink">{p.display}</span>
              <span className="tabular ml-2 inline-block w-9 text-right font-mono text-micro text-ink-faint">
                {SHARE.format((Math.max(p.value, 0) / sum) * 100)} %
              </span>
            </span>
          </div>
          <div className="h-2.5 overflow-hidden rounded-pill bg-surface-2">
            <div
              className="view-grow-x h-full rounded-pill"
              style={{
                width: `${Math.max((Math.abs(p.value) / max) * 100, p.value ? 2 : 0)}%`,
                background: color,
                opacity: i === 0 ? 1 : 0.78,
                animationDelay: `${i * 40}ms`,
              }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

/** Cifras cortas para el eje: «268 M», «1,2 mil». Con el prefijo o sufijo que traen los valores. */
function axisFormatter(sample: string | undefined): (n: number) => string {
  const compact = new Intl.NumberFormat('es-CO', { notation: 'compact', maximumFractionDigits: 1 });
  const money = sample?.trim().startsWith('$');
  const percent = sample?.trim().endsWith('%');
  return (n) => `${money ? '$ ' : ''}${compact.format(n)}${percent ? ' %' : ''}`;
}

/** Marcas «redondas» del eje (0, 50, 100…) que cubren el rango. */
function niceTicks(lo: number, hi: number, count = 4): number[] {
  const span = hi - lo || Math.abs(hi) || 1;
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = ([1, 2, 2.5, 5, 10].find((m) => m * mag >= raw) ?? 10) * mag;
  const start = Math.floor(lo / step) * step;
  const ticks: number[] = [];
  for (let v = start; v <= hi + step * 0.001; v += step) ticks.push(Number(v.toFixed(10)));
  if ((ticks[ticks.length - 1] ?? 0) < hi) ticks.push((ticks[ticks.length - 1] ?? 0) + step);
  return ticks;
}

function Line({ block }: { block: Chart }) {
  const gradient = `line-${useId().replace(/:/g, '')}`;
  const [active, setActive] = useState<number | null>(null);
  const points = block.points;
  const color = TONE_COLOR[block.tone];
  const { ticks, lo, hi } = useMemo(() => {
    const values = points.map((p) => p.value);
    const t = niceTicks(Math.min(0, ...values), Math.max(...values, 0));
    return { ticks: t, lo: t[0] ?? 0, hi: t[t.length - 1] ?? 1 };
  }, [points]);
  const fmt = useMemo(() => axisFormatter(points[0]?.display), [points]);
  const n = points.length;
  const xAt = (i: number) => (n > 1 ? (i / (n - 1)) * 100 : 50);
  const yAt = (v: number) => (1 - (v - lo) / (hi - lo || 1)) * 100;
  const W = 1000;
  const H = 300;
  const path = points
    .map(
      (p, i) =>
        `${i ? 'L' : 'M'}${((xAt(i) / 100) * W).toFixed(1)},${((yAt(p.value) / 100) * H).toFixed(1)}`,
    )
    .join(' ');
  const area = `${path} L${((xAt(n - 1) / 100) * W).toFixed(1)},${H} L${((xAt(0) / 100) * W).toFixed(1)},${H} Z`;
  const labelEvery = Math.max(1, Math.ceil(n / 6));
  const first = points[0];
  const last = points[n - 1];
  const shown = active === null ? null : points[active];

  const pick = (clientX: number, rect: DOMRect) => {
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    setActive(Math.round(ratio * (n - 1)));
  };

  return (
    <figure className="m-0">
      <div className="relative h-56 pl-14 pr-2 pt-2 pb-7 sm:h-64">
        {/* Rejilla y eje: HTML, para que el texto no se estire con el SVG. */}
        {ticks.map((t) => (
          <div
            key={t}
            aria-hidden
            className="absolute left-14 right-2 border-t border-dashed border-border"
            style={{ top: `calc(0.5rem + (100% - 2.25rem) * ${yAt(t) / 100})` }}
          >
            <span className="tabular absolute -left-14 -top-2 w-12 text-right font-mono text-micro text-ink-faint">
              {fmt(t)}
            </span>
          </div>
        ))}
        <div
          className="absolute bottom-7 left-14 right-2 top-2 cursor-crosshair rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          tabIndex={0}
          // Un deslizador de verdad: las flechas recorren los puntos y el lector
          // de pantalla dice cuál y cuánto.
          role="slider"
          aria-label={`${block.title}: de ${first?.display} (${first?.label}) a ${last?.display} (${last?.label})`}
          aria-valuemin={0}
          aria-valuemax={Math.max(n - 1, 0)}
          aria-valuenow={active ?? n - 1}
          aria-valuetext={`${(shown ?? last)?.label}: ${(shown ?? last)?.display}`}
          onPointerMove={(e) => pick(e.clientX, e.currentTarget.getBoundingClientRect())}
          onPointerDown={(e) => pick(e.clientX, e.currentTarget.getBoundingClientRect())}
          onPointerLeave={() => setActive(null)}
          onBlur={() => setActive(null)}
          onKeyDown={(e) => {
            if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
            e.preventDefault();
            setActive((a) =>
              Math.min(
                n - 1,
                Math.max(
                  0,
                  (a ?? (e.key === 'ArrowLeft' ? n : -1)) + (e.key === 'ArrowLeft' ? -1 : 1),
                ),
              ),
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
                <stop offset="0%" stopColor={color} stopOpacity={0.24} />
                <stop offset="100%" stopColor={color} stopOpacity={0} />
              </linearGradient>
            </defs>
            <path d={area} fill={`url(#${gradient})`} />
            <path
              d={path}
              fill="none"
              stroke={color}
              strokeWidth={2.5}
              strokeLinejoin="round"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
          </svg>
          {points.map((p, i) => (
            <span
              key={`${p.label}-${i}`}
              aria-hidden
              className={clsx(
                'pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 rounded-pill border-surface transition-transform duration-150',
                active === i
                  ? 'h-3.5 w-3.5 border-2'
                  : i === n - 1
                    ? 'h-2.5 w-2.5 border-2'
                    : 'hidden',
              )}
              style={{ left: `${xAt(i)}%`, top: `${yAt(p.value)}%`, background: color }}
            />
          ))}
          {shown && active !== null && (
            <>
              <span
                aria-hidden
                className="pointer-events-none absolute bottom-0 top-0 w-px bg-border-strong"
                style={{ left: `${xAt(active)}%` }}
              />
              <span
                className={clsx(
                  'pointer-events-none absolute z-10 whitespace-nowrap rounded-sm border border-border bg-surface px-2.5 py-1.5 shadow-pop',
                  xAt(active) > 70 ? '-translate-x-full -ml-2' : 'ml-2',
                )}
                style={{
                  left: `${xAt(active)}%`,
                  top: `${Math.max(0, Math.min(70, yAt(shown.value) - 18))}%`,
                }}
              >
                <span className="block text-micro text-ink-faint">{shown.label}</span>
                <span className="tabular block font-mono text-xs font-semibold text-ink">
                  {shown.display}
                </span>
              </span>
            </>
          )}
        </div>
        <div aria-hidden className="absolute bottom-0 left-14 right-2 h-5">
          {points.map((p, i) =>
            i % labelEvery === 0 || i === n - 1 ? (
              <span
                key={`${p.label}-${i}`}
                className={clsx(
                  'absolute top-1 whitespace-nowrap text-micro text-ink-faint',
                  i === 0 ? '' : i === n - 1 ? '-translate-x-full' : '-translate-x-1/2',
                  i !== n - 1 && i !== 0 && n - 1 - i < labelEvery && 'hidden',
                  // En un teléfono, una etiqueta sí y otra no: no caben todas.
                  i !== 0 && i !== n - 1 && (i / labelEvery) % 2 === 1 && 'max-sm:hidden',
                )}
                style={{ left: `${xAt(i)}%` }}
              >
                {p.label}
              </span>
            ) : null,
          )}
        </div>
      </div>
      <figcaption className="sr-only">
        {points.map((p) => `${p.label}: ${p.display}`).join('; ')}
      </figcaption>
    </figure>
  );
}

function Donut({ block }: { block: Chart }) {
  const [hover, setHover] = useState<number | null>(null);
  const colors = seriesColors(block.tone, useViewBrand());
  const total = block.points.reduce((a, p) => a + Math.max(p.value, 0), 0) || 1;
  const R = 40;
  const C = 2 * Math.PI * R;
  const gap = block.points.length > 1 ? 1.2 : 0;
  let offset = 0;
  const focus = hover === null ? null : block.points[hover];
  const color = (i: number) => colors[i % colors.length] ?? TONE_COLOR.primary;
  return (
    <div className="flex flex-col items-center gap-6 sm:flex-row sm:items-center">
      <div className="relative h-44 w-44 shrink-0">
        <svg
          viewBox="0 0 100 100"
          className="h-full w-full -rotate-90"
          role="img"
          aria-label={block.title}
        >
          <circle cx={50} cy={50} r={R} fill="none" className="stroke-surface-2" strokeWidth={13} />
          {block.points.map((p, i) => {
            const len = (Math.max(p.value, 0) / total) * C;
            const el = (
              <circle
                key={p.label}
                cx={50}
                cy={50}
                r={R}
                fill="none"
                stroke={color(i)}
                strokeWidth={hover === i ? 15 : 13}
                strokeDasharray={`${Math.max(len - gap, 0.01)} ${C - Math.max(len - gap, 0.01)}`}
                strokeDashoffset={-offset}
                opacity={hover === null || hover === i ? 1 : 0.3}
                className="transition-[opacity,stroke-width] duration-150"
                onPointerEnter={() => setHover(i)}
                onPointerLeave={() => setHover(null)}
              >
                <title>{`${p.label}: ${p.display}`}</title>
              </circle>
            );
            offset += len;
            return el;
          })}
        </svg>
        <div className="pointer-events-none absolute inset-0 grid place-items-center text-center">
          <div className="max-w-[7rem]">
            <p className="truncate text-micro font-semibold text-ink-faint">
              {focus ? focus.label : 'Total'}
            </p>
            <p className="tabular font-mono text-lg font-semibold leading-tight text-ink">
              {focus ? focus.display : block.total}
            </p>
            {focus && (
              <p className="tabular font-mono text-micro text-ink-faint">
                {SHARE.format((Math.max(focus.value, 0) / total) * 100)} %
              </p>
            )}
          </div>
        </div>
      </div>
      <ul className="w-full min-w-0 space-y-1">
        {block.points.map((p, i) => {
          const share = (Math.max(p.value, 0) / total) * 100;
          return (
            <li
              key={p.label}
              onPointerEnter={() => setHover(i)}
              onPointerLeave={() => setHover(null)}
              className={clsx(
                'grid grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-2.5 rounded-sm px-2 py-1.5 text-xs transition-colors duration-150',
                hover === i && 'bg-surface-2',
              )}
            >
              <span
                className="h-2.5 w-2.5 rounded-pill"
                style={{ background: color(i) }}
                aria-hidden
              />
              <span className="truncate text-ink">{p.label}</span>
              <span className="tabular font-mono font-semibold text-ink">{p.display}</span>
              <span className="tabular w-10 text-right font-mono text-micro text-ink-faint">
                {SHARE.format(share)} %
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
