'use client';

import { clsx } from 'clsx';
import { type ReactNode, useEffect, useId, useMemo, useState } from 'react';
import { ChartEmpty } from './ChartEmpty';
import { ChartLegend, type LegendItem } from './ChartLegend';
import { ChartTooltip, type TooltipRow } from './ChartTooltip';
import { AXIS, CHART_COLOR, GRID, SURFACE } from './colors';
import {
  type Pt,
  areaPath,
  bandPath,
  dataState,
  deltaRatio,
  describeTrend,
  formatCompact,
  labelIndexes,
  monotonePath,
  niceDomain,
  roundedBar,
} from './scales';
import { useChartWidth } from './use-chart-width';

/**
 * EL GRÁFICO DE EJES: líneas, áreas y barras sobre una misma escala.
 *
 * Una pieza para todo lo que tiene un eje de categorías (días, semanas, meses)
 * y uno de cifras. `AreaChart` y `BarChart` son sus dos caras; el flujo de caja
 * usa las dos a la vez (barras de entra/sale y la línea de caja).
 *
 * Lo que sabe hacer, porque lo piden los paneles de plata y de operación:
 *   - curvas monótonas con degradado, o rectas;
 *   - comparación (punteada y apagada), proyección (punteada, con su «rango
 *     probable» como banda) y umbral (raya rosa con su franja);
 *   - barras agrupadas o apiladas, con negativos hacia abajo y puntas
 *     redondeadas;
 *   - marcador de «ahora» y fichas de eventos;
 *   - guía + ficha al pasar el puntero, al tocar o con las flechas.
 *
 * El color es siempre `rgb(var(--token))`: claro y oscuro salen solos. Con
 * `prefers-reduced-motion` no hay entrada animada (ver globals.css, `.cx-*`).
 */

export interface LineSeries {
  id: string;
  label: string;
  color: string;
  values: Array<number | null>;
  /** Cifra de cada punto tal como se escribe (para la ficha). Por defecto, `formatValue`. */
  display?: string[];
  /** Relleno en degradado bajo la línea. */
  area?: boolean;
  /** Punteada. */
  dashed?: boolean;
  /** Serie de comparación («Semana pasada»): apagada, sin punto final. */
  comparison?: boolean;
  /** Desde este índice la serie es proyección: punteada. */
  projectedFrom?: number;
  /** «Rango probable» de la proyección, alineado con `values`. */
  band?: { lo: number[]; hi: number[]; label?: string };
  curve?: 'smooth' | 'linear';
  /** Un punto en cada valor. */
  dots?: boolean;
  /** Color del punto cuando hay que avisar (p. ej. caja bajo el mínimo). */
  dotColor?: (index: number) => string | undefined;
  /** Con la comparación: ¿subir es bueno? (por defecto sí). */
  goodWhenUp?: boolean;
}

export interface BarSeries {
  id: string;
  label: string;
  color: string;
  values: number[];
  display?: string[];
  /** Color de las barras bajo el cero (p. ej. una utilidad negativa en rosa). */
  negativeColor?: string;
  /** Índices que se dibujan más claros (p. ej. la semana en curso). */
  dim?: number[];
}

export interface ChartMarker {
  index: number;
  label: string;
  color?: string;
}

export interface ChartThreshold {
  value: number;
  label: string;
  color?: string;
}

export interface CartesianChartProps {
  /** Rótulo de cada posición del eje x. */
  labels: string[];
  /** Rótulo largo para la ficha (por defecto, el mismo). */
  titles?: string[];
  lines?: LineSeries[];
  bars?: BarSeries[];
  barMode?: 'stacked' | 'grouped';
  threshold?: ChartThreshold;
  markers?: ChartMarker[];
  /** Posición de «ahora» (línea vertical con su ficha). */
  nowIndex?: number;
  nowLabel?: string;
  /** Posición marcada (p. ej. la semana abierta). */
  selectedIndex?: number | null;
  onSelect?: (index: number) => void;
  /** Cifras del eje y. */
  formatAxis?: (n: number) => string;
  /** Cifras de la ficha. */
  formatValue?: (n: number) => string;
  /** La frase que oye un lector de pantalla. Por defecto, la tendencia de la primera serie. */
  ariaLabel?: string;
  height?: number;
  /** Incluye el cero en el eje (por defecto sí: un eje truncado exagera). */
  includeZero?: boolean;
  legend?: boolean;
  /** Notas extra en la leyenda. */
  legendExtra?: LegendItem[];
  emptyNote?: string;
  /** Texto bajo el gráfico dentro de la ficha (p. ej. «Toca para ver por qué»). */
  tooltipHint?: string;
  /** Fila extra en la ficha. */
  tooltipExtra?: (index: number) => ReactNode;
  className?: string;
  /** Pega el último valor al borde derecho (sparkline grande). */
  compactAxis?: boolean;
}

const EASE_GAP = 2;

export function CartesianChart(props: CartesianChartProps) {
  const {
    labels,
    titles,
    lines = [],
    bars = [],
    barMode = 'stacked',
    threshold,
    markers = [],
    nowIndex,
    nowLabel = 'ahora',
    selectedIndex = null,
    onSelect,
    formatAxis = (n) => formatCompact(n),
    formatValue = (n) => formatCompact(n),
    height = 220,
    includeZero = true,
    legend,
    legendExtra = [],
    emptyNote = 'Sin datos suficientes',
    tooltipHint,
    tooltipExtra,
    className,
  } = props;

  const uid = useId().replace(/:/g, '');
  const [box, width] = useChartWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);
  const n = labels.length;
  const hasBars = bars.length > 0;

  const state = dataState([...lines.map((l) => l.values), ...bars.map((b) => b.values)]);
  const faint = state === 'zero' || state === 'single';

  // ---- Eje y ---------------------------------------------------------------
  const domain = useMemo(() => {
    if (state === 'zero' || state === 'empty') return { min: 0, max: 4, ticks: [0] };
    const vals: number[] = [];
    for (const l of lines) {
      for (const v of l.values) if (v !== null) vals.push(v);
      if (l.band) vals.push(...l.band.hi, ...l.band.lo);
    }
    for (let i = 0; i < n; i++) {
      let pos = 0;
      let neg = 0;
      for (const b of bars) {
        const v = b.values[i] ?? 0;
        if (barMode === 'grouped') vals.push(v);
        else if (v >= 0) pos += v;
        else neg += v;
      }
      if (barMode === 'stacked' && bars.length) vals.push(pos, neg);
    }
    if (threshold) vals.push(threshold.value);
    return niceDomain(vals, { includeZero: includeZero || hasBars });
  }, [state, lines, bars, barMode, threshold, includeZero, hasBars, n]);

  // ---- Medidas -------------------------------------------------------------
  const markerLanes = useMemo(
    () => layoutMarkers(markers, nowIndex, nowLabel, n, width),
    [markers, nowIndex, nowLabel, n, width],
  );
  const labelW = Math.max(...domain.ticks.map((t) => formatAxis(t).length), 2) * 6.4 + 14;
  const pad = {
    left: Math.min(Math.max(labelW, 34), 88),
    right: 14,
    top: 12 + markerLanes.rows * 20,
    bottom: 26,
  };
  const plotW = Math.max(width - pad.left - pad.right, 10);
  const plotH = Math.max(height - pad.top - pad.bottom, 10);
  const band = plotW / Math.max(n, 1);
  const inset = hasBars ? band / 2 : Math.min(10, plotW / 12);
  const step = hasBars ? band : n > 1 ? (plotW - inset * 2) / (n - 1) : 0;
  const xAt = (i: number) =>
    n === 1 ? pad.left + plotW / 2 : pad.left + inset + (hasBars ? i * band : i * step);
  const yAt = (v: number) => pad.top + ((domain.max - v) / (domain.max - domain.min || 1)) * plotH;
  const y0 = yAt(0);
  const baseY = domain.min >= 0 ? pad.top + plotH : y0;

  // ---- Interacción ---------------------------------------------------------
  const pick = (clientX: number, rect: DOMRect) => {
    const px = clientX - rect.left;
    const i = hasBars ? Math.floor(px / band) : n > 1 ? Math.round((px - inset) / step) : 0;
    setActive(Math.min(n - 1, Math.max(0, i)));
  };
  useEffect(() => {
    if (active === null) return;
    const away = (e: PointerEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setActive(null);
    };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [active, box]);

  // ---- Frases --------------------------------------------------------------
  const primary = lines.find((l) => !l.comparison) ?? lines[0];
  const summary = (() => {
    if (props.ariaLabel) return props.ariaLabel;
    if (primary)
      return describeTrend({
        name: primary.label,
        labels,
        values: primary.values,
        format: formatValue,
      });
    const b = bars[0];
    if (b) {
      return `${b.label}: ${labels.map((l, i) => `${l} ${formatValue(b.values[i] ?? 0)}`).join(', ')}.`;
    }
    return 'Gráfico sin datos.';
  })();

  const rowsAt = (i: number): TooltipRow[] => {
    const rows: TooltipRow[] = [];
    const cmp = lines.find((l) => l.comparison);
    for (const l of lines) {
      const v = l.values[i];
      if (v === null || v === undefined) continue;
      const projected = l.projectedFrom !== undefined && i > l.projectedFrom;
      const row: TooltipRow = {
        label: projected ? `${l.label} (proyección)` : l.label,
        value: l.display?.[i] ?? formatValue(v),
        color: l.color,
        muted: l.comparison,
        dashed: l.dashed || l.comparison || projected,
      };
      if (cmp && l !== cmp && !l.comparison) {
        const prev = cmp.values[i];
        if (prev !== null && prev !== undefined) {
          row.delta = deltaRatio(v, prev);
          row.good = row.delta === null ? null : row.delta >= 0 === (l.goodWhenUp ?? true);
        }
      }
      rows.push(row);
      if (l.band && l.projectedFrom !== undefined && i > l.projectedFrom) {
        rows.push({
          label: l.band.label ?? 'Rango probable',
          value: `${formatValue(l.band.lo[i] ?? v)} – ${formatValue(l.band.hi[i] ?? v)}`,
          color: l.color,
          muted: true,
        });
      }
    }
    for (const b of bars) {
      const v = b.values[i];
      if (v === undefined) continue;
      rows.push({
        label: b.label,
        value: b.display?.[i] ?? formatValue(v),
        color: v < 0 && b.negativeColor ? b.negativeColor : b.color,
      });
    }
    return rows;
  };

  const legendItems: LegendItem[] = [
    ...bars.map<LegendItem>((b) => ({ label: b.label, color: b.color, kind: 'bar' })),
    ...lines.map<LegendItem>((l) => ({
      label: l.label,
      color: l.color,
      kind: l.dashed || l.comparison ? 'dash' : 'line',
    })),
    ...lines
      .filter((l) => l.band)
      .map<LegendItem>((l) => ({
        label: l.band?.label ?? 'Rango probable',
        color: l.color,
        kind: 'band',
      })),
    ...(threshold
      ? [
          {
            label: threshold.label,
            color: threshold.color ?? CHART_COLOR.rose,
            kind: 'dash' as const,
          },
        ]
      : []),
    ...legendExtra,
  ];
  const showLegend = legend ?? legendItems.length > 1;

  if (state === 'empty' || n === 0) {
    return (
      <div className={className}>
        <ChartEmpty note={emptyNote} height={height} />
      </div>
    );
  }

  const ready = width > 0;
  const xLabels = labelIndexes(
    n,
    Math.floor(plotW / (Math.max(...labels.map((l) => l.length), 3) * 6.8 + 18)),
  );
  const tipRows = active !== null ? rowsAt(active) : [];
  const ax = active !== null ? xAt(active) : 0;
  const activeText =
    active !== null
      ? `${titles?.[active] ?? labels[active]}: ${tipRows.map((r) => `${r.label} ${r.value}`).join(', ')}`
      : '';

  return (
    <div className={className}>
      {showLegend && <ChartLegend items={legendItems} className="mb-3" />}
      <div
        ref={box}
        className="relative w-full select-none rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
        style={{ height }}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: el gráfico se recorre con las flechas.
        tabIndex={0}
        role="img"
        aria-label={summary}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
            e.preventDefault();
            const dir = e.key === 'ArrowLeft' ? -1 : 1;
            setActive((a) => Math.min(n - 1, Math.max(0, (a ?? (dir < 0 ? n : -1)) + dir)));
          } else if (e.key === 'Home') {
            e.preventDefault();
            setActive(0);
          } else if (e.key === 'End') {
            e.preventDefault();
            setActive(n - 1);
          } else if (e.key === 'Escape') {
            setActive(null);
          } else if ((e.key === 'Enter' || e.key === ' ') && active !== null && onSelect) {
            e.preventDefault();
            onSelect(active);
          }
        }}
        onBlur={() => setActive(null)}
      >
        {ready && (
          <svg width={width} height={height} className="block overflow-visible" aria-hidden="true">
            <defs>
              {lines.map((l, si) =>
                l.area ? (
                  <linearGradient key={l.id} id={`${uid}-g${si}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={l.color} stopOpacity={l.comparison ? 0.12 : 0.3} />
                    <stop offset="100%" stopColor={l.color} stopOpacity={0} />
                  </linearGradient>
                ) : null,
              )}
            </defs>

            {/* Rejilla y eje y */}
            {domain.ticks.map((t) => (
              <g key={t}>
                <line
                  x1={pad.left}
                  x2={width - pad.right}
                  y1={yAt(t)}
                  y2={yAt(t)}
                  stroke={t === 0 && domain.min < 0 ? AXIS : GRID}
                  strokeWidth={1}
                  strokeDasharray={t === 0 ? undefined : '2 4'}
                />
                <text
                  x={pad.left - 8}
                  y={yAt(t)}
                  dy="0.32em"
                  textAnchor="end"
                  fontSize={11}
                  className="fill-ink-faint tabular-nums"
                >
                  {formatAxis(t)}
                </text>
              </g>
            ))}

            {/* Franja bajo el umbral */}
            {threshold && (
              <rect
                x={pad.left}
                y={yAt(threshold.value)}
                width={plotW}
                height={Math.max(
                  (domain.min < 0 && threshold.value > 0 ? y0 : pad.top + plotH) -
                    yAt(threshold.value),
                  0,
                )}
                fill={threshold.color ?? CHART_COLOR.rose}
                opacity={0.07}
              />
            )}

            {/* Posición abierta o bajo el puntero */}
            {selectedIndex !== null && selectedIndex >= 0 && selectedIndex < n && hasBars && (
              <rect
                x={xAt(selectedIndex) - band / 2 + 1}
                y={pad.top}
                width={Math.max(band - 2, 1)}
                height={plotH}
                rx={8}
                fill="rgb(var(--primary) / 0.1)"
              />
            )}
            {active !== null &&
              (hasBars ? (
                <rect
                  x={xAt(active) - band / 2 + 1}
                  y={pad.top}
                  width={Math.max(band - 2, 1)}
                  height={plotH}
                  rx={8}
                  fill="rgb(var(--ink) / 0.045)"
                />
              ) : (
                <line
                  x1={xAt(active)}
                  x2={xAt(active)}
                  y1={pad.top}
                  y2={pad.top + plotH}
                  stroke={AXIS}
                  strokeWidth={1}
                />
              ))}

            {/* Bandas de proyección */}
            {lines.map((l) => {
              if (!l.band || l.projectedFrom === undefined) return null;
              const idx = rangeFrom(l.projectedFrom, n).filter(
                (i) => l.band && l.band.hi[i] !== undefined && l.band.lo[i] !== undefined,
              );
              const hi = idx.map((i) => ({ x: xAt(i), y: yAt(l.band?.hi[i] ?? 0) }));
              const lo = idx.map((i) => ({ x: xAt(i), y: yAt(l.band?.lo[i] ?? 0) }));
              return (
                <g key={`band-${l.id}`} className="cx-fade">
                  <path d={bandPath(hi, lo)} fill={l.color} opacity={0.14} />
                </g>
              );
            })}

            {/* Barras */}
            {hasBars &&
              Array.from({ length: n }, (_, i) =>
                barShapes(i).map((s) => (
                  <path
                    key={`${i}-${s.id}`}
                    d={s.d}
                    fill={s.color}
                    opacity={(faint ? 0.35 : 1) * (s.dim ? 0.45 : 1)}
                    className={clsx('cx-grow', s.down && 'cx-grow-down')}
                    style={{ animationDelay: `${Math.min(i * 28, 400)}ms` }}
                  />
                )),
              )}

            {/* Áreas */}
            {lines.map((l, si) => {
              if (!l.area) return null;
              const pts = linePoints(l, 0, l.projectedFrom ?? n - 1);
              if (pts.length < 2) return null;
              return (
                <g key={`area-${l.id}`} className="cx-fade">
                  <path
                    d={l.curve === 'linear' ? linearArea(pts, baseY) : areaPath(pts, baseY)}
                    fill={`url(#${uid}-g${si})`}
                    opacity={faint ? 0.4 : 1}
                  />
                </g>
              );
            })}

            {/* Líneas: comparaciones primero, la principal encima */}
            {[...lines]
              .sort((a, b) => Number(!!b.comparison) - Number(!!a.comparison))
              .map((l) => {
                const solidTo = l.projectedFrom ?? n - 1;
                const solid = linePoints(l, 0, solidTo);
                const proj =
                  l.projectedFrom !== undefined ? linePoints(l, l.projectedFrom, n - 1) : [];
                const d = (p: Pt[]) => (l.curve === 'linear' ? linearPath(p) : monotonePath(p));
                const muted = l.comparison || faint;
                return (
                  <g key={`line-${l.id}`} opacity={muted ? (l.comparison ? 0.55 : 0.5) : 1}>
                    {solid.length >= 2 &&
                      (l.dashed || l.comparison ? (
                        <path
                          d={d(solid)}
                          fill="none"
                          stroke={l.color}
                          strokeWidth={l.comparison ? 1.5 : 2}
                          strokeDasharray="5 4"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          className="cx-fade"
                        />
                      ) : (
                        <path
                          d={d(solid)}
                          pathLength={1}
                          fill="none"
                          stroke={l.color}
                          strokeWidth={2.25}
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          className="cx-draw"
                        />
                      ))}
                    {proj.length >= 2 && (
                      <path
                        d={d(proj)}
                        fill="none"
                        stroke={l.color}
                        strokeWidth={2}
                        strokeDasharray="5 4"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className="cx-fade"
                      />
                    )}
                  </g>
                );
              })}

            {/* Umbral */}
            {threshold && (
              <g>
                <line
                  x1={pad.left}
                  x2={width - pad.right}
                  y1={yAt(threshold.value)}
                  y2={yAt(threshold.value)}
                  stroke={threshold.color ?? CHART_COLOR.rose}
                  strokeWidth={1.25}
                  strokeDasharray="5 4"
                />
                <ThresholdChip
                  x={width - pad.right - 4}
                  y={yAt(threshold.value)}
                  text={`${threshold.label} · ${formatAxis(threshold.value)}`}
                  color={threshold.color ?? CHART_COLOR.rose}
                  below={yAt(threshold.value) < pad.top + 22}
                />
              </g>
            )}

            {/* Ahora y eventos */}
            {markerLanes.items.map((m) => {
              const top = 2 + m.lane * 20;
              const left = Math.min(
                Math.max(xAt(m.index) - m.width / 2, pad.left - 8),
                width - pad.right - m.width + 8,
              );
              return (
                <g key={`${m.kind}-${m.index}-${m.label}`}>
                  <line
                    x1={xAt(m.index)}
                    x2={xAt(m.index)}
                    y1={top + 16}
                    y2={pad.top + plotH}
                    stroke={m.color}
                    strokeWidth={1}
                    strokeDasharray={m.kind === 'now' ? '3 3' : '1 3'}
                    opacity={0.7}
                  />
                  <rect
                    x={left}
                    y={top}
                    width={m.width}
                    height={16}
                    rx={8}
                    fill={SURFACE}
                    stroke={m.color}
                    strokeWidth={1}
                  />
                  <text
                    x={left + m.width / 2}
                    y={top + 11.5}
                    textAnchor="middle"
                    fontSize={10.5}
                    fontWeight={600}
                    className="fill-ink"
                  >
                    {m.label}
                  </text>
                </g>
              );
            })}

            {/* El punto de hoy: halo y punto en el último valor */}
            {lines.map((l) => {
              if (l.comparison) return null;
              const pts = linePoints(l, 0, n - 1);
              const last = pts[pts.length - 1];
              const showAll = l.dots;
              return (
                <g key={`dots-${l.id}`} className="cx-fade">
                  {showAll &&
                    pts.map((p) => (
                      <circle
                        key={`${l.id}-${p.i}`}
                        cx={p.x}
                        cy={p.y}
                        r={3}
                        fill={l.dotColor?.(p.i) ?? l.color}
                        stroke={SURFACE}
                        strokeWidth={1.5}
                      />
                    ))}
                  {last && !faint && (
                    <>
                      <circle cx={last.x} cy={last.y} r={8} fill={l.color} opacity={0.18} />
                      <circle
                        cx={last.x}
                        cy={last.y}
                        r={4}
                        fill={l.color}
                        stroke={SURFACE}
                        strokeWidth={2}
                      />
                    </>
                  )}
                  {last && faint && (
                    <circle
                      cx={last.x}
                      cy={last.y}
                      r={3.5}
                      fill={l.color}
                      stroke={SURFACE}
                      strokeWidth={2}
                    />
                  )}
                </g>
              );
            })}

            {/* Puntos bajo la guía */}
            {active !== null &&
              lines.map((l) => {
                const v = l.values[active];
                if (v === null || v === undefined) return null;
                return (
                  <circle
                    key={`act-${l.id}`}
                    cx={xAt(active)}
                    cy={yAt(v)}
                    r={l.comparison ? 3 : 5}
                    fill={l.color}
                    stroke={SURFACE}
                    strokeWidth={2}
                  />
                );
              })}

            {/* Eje x */}
            {xLabels.map((i) => (
              <text
                key={`x-${i}`}
                x={xAt(i)}
                y={height - 8}
                textAnchor={
                  !hasBars && i === 0 && n > 1
                    ? 'start'
                    : !hasBars && i === n - 1 && n > 1
                      ? 'end'
                      : 'middle'
                }
                fontSize={11}
                className={clsx('tabular-nums', i === active ? 'fill-ink' : 'fill-ink-faint')}
              >
                {labels[i]}
              </text>
            ))}
          </svg>
        )}

        {/* Superficie del puntero */}
        {ready && (
          // biome-ignore lint/a11y/useKeyWithClickEvents: el teclado lo atiende el contenedor (flechas + Enter).
          <div
            className={clsx('absolute', onSelect ? 'cursor-pointer' : 'cursor-crosshair')}
            style={{
              left: pad.left,
              top: pad.top,
              width: plotW,
              height: plotH,
              touchAction: 'pan-y',
            }}
            onPointerMove={(e) => {
              pick(e.clientX, e.currentTarget.getBoundingClientRect());
            }}
            onPointerDown={(e) => {
              pick(e.clientX, e.currentTarget.getBoundingClientRect());
            }}
            onPointerLeave={(e) => {
              if (e.pointerType === 'mouse') setActive(null);
            }}
            onClick={() => {
              if (active !== null && onSelect) onSelect(active);
            }}
          />
        )}

        {ready && active !== null && tipRows.length > 0 && (
          <ChartTooltip
            className="absolute"
            title={titles?.[active] ?? labels[active] ?? ''}
            rows={tipRows}
            footer={
              <>
                {tooltipExtra?.(active)}
                {tooltipHint}
              </>
            }
            style={{
              top: 0,
              ...(ax > width * 0.55
                ? { right: Math.max(width - ax + 12, 4) }
                : { left: Math.min(Math.max(ax + 12, 4), width - 160) }),
            }}
          />
        )}

        {state !== 'ok' && ready && (
          <p
            className="pointer-events-none absolute inset-x-0 text-center text-xs text-ink-faint"
            style={{ top: pad.top + plotH * 0.3 }}
          >
            {emptyNote}
          </p>
        )}
        <span className="sr-only" aria-live="polite">
          {activeText}
        </span>
      </div>
    </div>
  );

  // ---- Auxiliares que usan las escalas de arriba ------------------------------
  function linePoints(l: LineSeries, from: number, to: number): Array<Pt & { i: number }> {
    const out: Array<Pt & { i: number }> = [];
    for (let i = Math.max(from, 0); i <= Math.min(to, n - 1); i++) {
      const v = l.values[i];
      if (v !== null && v !== undefined) out.push({ x: xAt(i), y: yAt(v), i });
    }
    return out;
  }

  function barShapes(i: number) {
    const out: Array<{ id: string; d: string; color: string; dim: boolean; down: boolean }> = [];
    const k = bars.length;
    if (barMode === 'grouped') {
      const bw = Math.max(2, Math.min(22, (band * 0.7 - EASE_GAP * (k - 1)) / k));
      const total = bw * k + EASE_GAP * (k - 1);
      bars.forEach((b, bi) => {
        const v = b.values[i] ?? 0;
        const x = xAt(i) - total / 2 + bi * (bw + EASE_GAP);
        out.push({
          id: b.id,
          d: roundedBar(x, y0, yAt(v), bw),
          color: v < 0 && b.negativeColor ? b.negativeColor : b.color,
          dim: !!b.dim?.includes(i),
          down: v < 0,
        });
      });
      return out;
    }
    const bw = Math.max(3, Math.min(30, band * 0.62));
    let up = 0;
    let down = 0;
    bars.forEach((b, bi) => {
      const v = b.values[i] ?? 0;
      if (v === 0) return;
      const isUp = v >= 0;
      const from = isUp ? up : down;
      const to = from + v;
      if (isUp) up = to;
      else down = to;
      // Un hueco entre tramos: el borde de dentro se corre `EASE_GAP`.
      const gap = from === 0 ? 0 : EASE_GAP;
      const a = yAt(from) + (isUp ? -gap : gap);
      const z = yAt(to);
      const isTop = !bars.slice(bi + 1).some((o) => (o.values[i] ?? 0) * (isUp ? 1 : -1) > 0);
      out.push({
        id: b.id,
        d: roundedBar(xAt(i) - bw / 2, a, z, bw, isTop ? 4 : 1.5, 1.5),
        color: !isUp && b.negativeColor ? b.negativeColor : b.color,
        dim: !!b.dim?.includes(i),
        down: !isUp,
      });
    });
    return out;
  }
}

function rangeFrom(from: number, n: number): number[] {
  const out: number[] = [];
  for (let i = Math.max(from, 0); i < n; i++) out.push(i);
  return out;
}

function linearPath(pts: Pt[]): string {
  return pts.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join('');
}
function linearArea(pts: Pt[], baseY: number): string {
  const first = pts[0] as Pt;
  const last = pts[pts.length - 1] as Pt;
  return `${linearPath(pts)}L${last.x.toFixed(1)},${baseY}L${first.x.toFixed(1)},${baseY}Z`;
}

function ThresholdChip({
  x,
  y,
  text,
  color,
  below,
}: { x: number; y: number; text: string; color: string; below: boolean }) {
  const w = text.length * 6 + 14;
  const top = below ? y + 4 : y - 20;
  return (
    <g>
      <rect
        x={x - w}
        y={top}
        width={w}
        height={16}
        rx={8}
        fill={SURFACE}
        stroke={color}
        strokeWidth={1}
        opacity={0.95}
      />
      <text
        x={x - w / 2}
        y={top + 11.5}
        textAnchor="middle"
        fontSize={10.5}
        fontWeight={600}
        fill={color}
      >
        {text}
      </text>
    </g>
  );
}

interface PlacedMarker {
  kind: 'now' | 'event';
  index: number;
  label: string;
  color: string;
  lane: number;
  width: number;
}

/** Reparte «ahora» y los eventos en filas para que sus fichas no se pisen. */
function layoutMarkers(
  markers: ChartMarker[],
  nowIndex: number | undefined,
  nowLabel: string,
  n: number,
  width: number,
): { items: PlacedMarker[]; rows: number } {
  const all: Array<Omit<PlacedMarker, 'lane' | 'width'>> = [];
  if (nowIndex !== undefined && nowIndex >= 0 && nowIndex < n)
    all.push({ kind: 'now', index: nowIndex, label: nowLabel, color: 'rgb(var(--primary))' });
  for (const m of markers)
    if (m.index >= 0 && m.index < n)
      all.push({
        kind: 'event',
        index: m.index,
        label: m.label,
        color: m.color ?? 'rgb(var(--ink-muted))',
      });
  if (all.length === 0 || width <= 0) return { items: [], rows: 0 };
  all.sort((a, b) => a.index - b.index);
  const ends: number[] = [];
  const unit = width / Math.max(n, 1);
  const items = all.map((m) => {
    const w = m.label.length * 5.8 + 16;
    const left = (m.index + 0.5) * unit - w / 2;
    let lane = ends.findIndex((e) => e + 4 <= left);
    if (lane === -1) {
      lane = ends.length;
      ends.push(0);
    }
    ends[lane] = left + w;
    return { ...m, lane, width: w };
  });
  return { items, rows: ends.length };
}
