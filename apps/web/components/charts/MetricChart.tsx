'use client';

import { clsx } from 'clsx';
import { Download, Minus, Plus, RotateCcw, Sparkles } from 'lucide-react';
import Link from 'next/link';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  type BarSeries,
  CartesianChart,
  type ChartMarker,
  type LineSeries,
} from './CartesianChart';
import { DrillSheet } from './DrillSheet';
import { CHART_COLOR } from './colors';
import { downloadPng, downloadSvg, downloadText, fileSlug } from './export';
import {
  type Bucket,
  type PeriodSummary,
  RANGES,
  type RangeDef,
  type RangeId,
  type Zoom,
  alignProjection,
  askHref,
  askPrompt,
  brushToZoom,
  bucketIndexOf,
  bucketize,
  comparisonValues,
  dayLabel,
  isZoomed,
  periodSummary,
  rangeById,
  rangeWindow,
  recordsForBucket,
  seriesCsv,
  sliceZoom,
  zoomAround,
} from './interactive';
import { metricFormatters } from './metric-format';
import type { MetricModel } from './metric-types';
import { describeTrend } from './scales';

/**
 * EL GRÁFICO DE UNA MÉTRICA, CON TODO LO QUE SE LE PUEDE PEDIR.
 *
 * Por defecto es sólo la cifra y el gráfico. Alrededor, una barra compacta:
 * rango (7 d · 30 d · 90 d · 12 m), «comparar con el período anterior»,
 * preguntarle a Cortex, descargar (CSV, PNG, SVG) y —al pasar el puntero, al
 * enfocar o ya con zoom— acercar, alejar y restablecer. Arrastrar sobre el
 * gráfico marca un rango y lo acerca; doble clic o doble toque acerca ahí; un
 * clic abre los registros de ese punto. `+`, `-` y `0` hacen lo mismo con el
 * teclado, y las flechas recorren los puntos.
 *
 * Todo el cálculo vive en `interactive.ts` (puro y probado); aquí sólo se junta.
 */

export interface MetricChartInfo {
  summary: PeriodSummary;
  range: RangeDef;
  comparing: boolean;
  /** Primer y último día de lo que se ve. */
  from: string;
  to: string;
}

export function MetricChart({
  metric,
  today,
  defaultRange = '30d',
  height = 260,
  renderHeader,
  className,
}: {
  metric: MetricModel;
  today: string;
  defaultRange?: RangeId;
  height?: number;
  /** Para poner la cifra grande encima, con el cambio del período. */
  renderHeader?: (info: MetricChartInfo) => ReactNode;
  className?: string;
}) {
  const [rangeId, setRangeId] = useState<RangeId>(defaultRange);
  const [compare, setCompare] = useState(false);
  const [inOut, setInOut] = useState(false);
  const [zoom, setZoom] = useState<Zoom | null>(null);
  const [drill, setDrill] = useState<number | null>(null);
  const [menu, setMenu] = useState(false);
  const [busy, setBusy] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const range = rangeById(rangeId);
  const fmt = useMemo(() => metricFormatters(metric), [metric]);
  const mode = metric.kind === 'stock' ? 'last' : 'sum';

  // Cambiar de rango o de métrica deshace el zoom y cierra lo abierto.
  // biome-ignore lint/correctness/useExhaustiveDependencies: es justo lo que se quiere observar.
  useEffect(() => {
    setZoom(null);
    setDrill(null);
  }, [rangeId, metric.id]);

  useEffect(() => {
    if (!menu) return;
    const away = (e: PointerEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setMenu(false);
    };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [menu]);

  const model = useMemo(() => {
    const win = rangeWindow(today, range);
    const hasProjection = metric.kind === 'stock' && (metric.projection?.length ?? 0) > 0;
    const horizon = hasProjection || metric.futureInDaily ? range.horizon : 0;
    const raw = bucketize(metric.daily, win, range, { mode, horizon, today });
    const buckets: Bucket[] = raw.map((b) =>
      metric.kind === 'stock' && b.future ? { ...b, value: null } : b,
    );
    const nowIndex = buckets.findIndex((b) => b.isNow);
    const n = buckets.length;
    const cmp = comparisonValues(metric.daily, today, range, mode, n).map((v, i) =>
      nowIndex >= 0 && i > nowIndex ? null : v,
    );
    const prevWin = rangeWindow(today, range, 1);
    const prevBuckets = bucketize([], prevWin, range, { mode, today: prevWin.to });
    const summary = periodSummary(buckets, cmp, mode);
    const proj =
      hasProjection && nowIndex >= 0
        ? alignProjection(buckets, metric.projection ?? [], {
            index: nowIndex,
            value: buckets[nowIndex]?.value ?? metric.daily.at(-1)?.value ?? 0,
          })
        : null;
    const inflow = metric.inOut
      ? bucketize(metric.inOut.inflow, win, range, { mode: 'sum', horizon, today })
      : [];
    const outflow = metric.inOut
      ? bucketize(metric.inOut.outflow, win, range, { mode: 'sum', horizon, today })
      : [];
    return { win, buckets, nowIndex, n, cmp, prevBuckets, summary, proj, inflow, outflow };
  }, [metric, range, mode, today]);

  const { buckets, nowIndex, n, cmp, prevBuckets, summary, proj } = model;
  const z: Zoom = zoom ? [Math.max(0, zoom[0]), Math.min(n - 1, zoom[1])] : [0, n - 1];
  const zoomed = isZoomed(zoom, n);
  const off = zoomed ? z[0] : 0;

  // ---- Series para el gráfico (ya recortadas al zoom) ----------------------
  const chart = useMemo(() => {
    const color = CHART_COLOR[metric.tone];
    const cut: Zoom | null = zoomed ? [z[0], z[1]] : null;
    const sl = <T,>(a: readonly T[]) => sliceZoom(a, cut);
    const labels = sl(buckets.map((b) => b.label));
    const titles = sl(buckets.map((b) => (b.future ? `${b.title} · proyección` : b.title)));
    const lines: LineSeries[] = [];
    const bars: BarSeries[] = [];
    if (metric.kind === 'stock') {
      const merged = buckets.map((b, i) => (i <= nowIndex ? b.value : (proj?.values[i] ?? null)));
      lines.push({
        id: metric.id,
        label: metric.label,
        color,
        values: sl(merged),
        area: true,
        curve: 'smooth',
        projectedFrom: proj && nowIndex - off >= 0 ? nowIndex - off : undefined,
        band:
          proj && nowIndex >= 0
            ? {
                lo: sl(proj.lo),
                hi: sl(proj.hi),
                label: 'Rango probable',
              }
            : undefined,
        goodWhenUp: metric.goodWhenUp,
      });
    } else {
      bars.push({
        id: metric.id,
        label: metric.label,
        color,
        values: sl(buckets.map((b) => b.value ?? 0)),
        goodWhenUp: metric.goodWhenUp,
        dim: buckets.flatMap((b, i) => (b.future && i >= off ? [i - off] : [])),
      });
    }
    if (inOut && metric.inOut && model.inflow.length) {
      bars.push(
        {
          id: 'entra',
          label: 'Entra',
          color: CHART_COLOR.emerald,
          values: sl(model.inflow.map((b) => b.value ?? 0)),
        },
        {
          id: 'sale',
          label: 'Sale',
          color: CHART_COLOR.rose,
          values: sl(model.outflow.map((b) => -(b.value ?? 0))),
        },
      );
    }
    if (compare) {
      lines.push({
        id: `${metric.id}-prev`,
        label: 'Período anterior',
        color,
        values: sl(cmp),
        comparison: true,
        curve: 'smooth',
        goodWhenUp: metric.goodWhenUp,
      });
    }
    const markers: ChartMarker[] = [];
    const seen = new Set<string>();
    for (const e of metric.events ?? []) {
      const idx = bucketIndexOf(buckets, e.date) - off;
      if (idx < 0 || idx >= labels.length) continue;
      const key = `${idx}|${e.label}`;
      if (seen.has(key)) continue;
      seen.add(key);
      markers.push({ index: idx, label: e.label, color: CHART_COLOR[e.tone ?? 'amber'] });
    }
    // Cinco como mucho, los más cercanos a hoy; en pantalla, de izquierda a derecha.
    const nowRel0 = nowIndex - off;
    const picked = [...markers]
      .sort((a, b) => Math.abs(a.index - nowRel0) - Math.abs(b.index - nowRel0))
      .slice(0, 5)
      .sort((a, b) => a.index - b.index);
    const nowRel = nowIndex - off;
    return {
      labels,
      titles,
      lines,
      bars,
      markers: picked,
      now: nowRel >= 0 && nowRel < labels.length - 1 ? nowRel : undefined,
    };
  }, [
    metric,
    buckets,
    proj,
    nowIndex,
    off,
    zoomed,
    z,
    compare,
    inOut,
    cmp,
    model.inflow,
    model.outflow,
  ]);

  // ---- Zoom ----------------------------------------------------------------
  const visibleLen = z[1] - z[0] + 1;
  const applyZoom = useCallback(
    (factor: number, center?: number) => {
      const next = zoomAround(z, n, factor, center === undefined ? undefined : center + off);
      setZoom(isZoomed(next, n) ? next : null);
    },
    [z, n, off],
  );

  // ---- Frases --------------------------------------------------------------
  const current = summary.current;
  const headline = current === null ? null : fmt.value(current);
  const fromDay = buckets[z[0]]?.start ?? model.win.from;
  const lastShown = buckets[Math.min(z[1], nowIndex >= 0 ? nowIndex : z[1])];
  const toDay = lastShown?.end ?? today;
  const zoomNote = zoomed ? `Acercado del ${dayLabel(fromDay)} al ${dayLabel(toDay)}.` : undefined;
  const aria = `${metric.label}, ${range.phrase}. ${describeTrend({
    name: metric.label,
    labels: chart.labels,
    values: (chart.lines[0]?.values ?? chart.bars[0]?.values ?? []).map((v) => v ?? 0),
    format: fmt.value,
  })} Flechas para recorrer los puntos, Enter para ver los registros, más y menos para acercar.`;

  const coverageFrom = metric.daily[0]?.date;
  const partial = !!coverageFrom && coverageFrom > model.win.from && coverageFrom <= today;

  // ---- Acciones ------------------------------------------------------------
  const exportName = fileSlug(metric.label, range.id, today);
  const doCsv = () => {
    const rows = [
      { label: metric.label, values: buckets.map((b) => b.value) },
      ...(compare ? [{ label: 'Período anterior', values: cmp }] : []),
      ...(proj
        ? [
            { label: 'Proyección', values: proj.values.map((v, i) => (i > nowIndex ? v : null)) },
            {
              label: 'Rango probable (mín.)',
              values: proj.lo.map((v, i) => (i > nowIndex ? v : null)),
            },
            {
              label: 'Rango probable (máx.)',
              values: proj.hi.map((v, i) => (i > nowIndex ? v : null)),
            },
          ]
        : []),
    ];
    downloadText(
      seriesCsv(
        buckets.map((b) => (b.start === b.end ? b.start : `${b.start} a ${b.end}`)),
        rows,
        'Período',
      ),
      `${exportName}.csv`,
    );
    setMenu(false);
  };
  const doImage = async (kind: 'png' | 'svg') => {
    if (!root.current) return;
    setBusy(true);
    const title = `${metric.label} · ${range.phrase} · ${today}`;
    if (kind === 'svg') downloadSvg(root.current, `${exportName}.svg`, title);
    else await downloadPng(root.current, `${exportName}.png`, title);
    setBusy(false);
    setMenu(false);
  };

  const ask = askHref(
    askPrompt({
      metric: metric.label,
      rangePhrase: range.phrase,
      from: fromDay,
      to: toDay,
      headline,
      focus: zoomed ? 'el tramo que acerqué' : null,
    }),
  );

  // ---- Lo que hay detrás del punto abierto ----------------------------------
  const recKind = metric.recordsKind ?? metric.kind;
  const drillBucket = drill !== null ? (buckets[drill] ?? null) : null;
  const drillData = useMemo(
    () =>
      drillBucket && metric.records
        ? recordsForBucket(metric.records, drillBucket, recKind)
        : { rows: [], total: 0, sum: 0 },
    [drillBucket, metric.records, recKind],
  );

  const btn =
    'inline-flex h-8 min-w-8 items-center justify-center gap-1.5 rounded-pill px-2 text-xs font-semibold text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary/40 disabled:opacity-40';
  const tools = clsx(
    'flex items-center gap-0.5 transition-opacity',
    zoomed
      ? 'opacity-100'
      : 'opacity-0 focus-within:opacity-100 group-hover/mc:opacity-100 [@media(hover:none)]:opacity-100',
  );

  return (
    <div ref={root} className={clsx('group/mc relative', className)}>
      {renderHeader?.({
        summary,
        range,
        comparing: compare,
        from: model.win.from,
        to: today,
      })}

      <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1">
        <div role="radiogroup" aria-label="Rango" className="flex rounded-pill bg-surface-2 p-0.5">
          {RANGES.map((r) => (
            <button
              key={r.id}
              type="button"
              // biome-ignore lint/a11y/useSemanticElements: grupo de opciones compacto.
              role="radio"
              aria-checked={r.id === rangeId}
              aria-label={r.phrase}
              onClick={() => setRangeId(r.id)}
              className={clsx(
                'h-7 rounded-pill px-3 text-xs font-semibold tabular-nums transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary/40',
                r.id === rangeId
                  ? 'bg-surface text-ink shadow-card'
                  : 'text-ink-muted hover:text-ink',
              )}
            >
              {r.label}
            </button>
          ))}
        </div>

        <button
          type="button"
          role="switch"
          aria-checked={compare}
          onClick={() => setCompare((c) => !c)}
          className={clsx(btn, 'px-2.5', compare && 'bg-primary-soft text-primary-ink')}
        >
          <span
            aria-hidden
            className={clsx(
              'relative h-3.5 w-6 rounded-pill transition-colors',
              compare ? 'bg-primary' : 'bg-border-strong',
            )}
          >
            <span
              className={clsx(
                'absolute top-0.5 h-2.5 w-2.5 rounded-pill bg-surface transition-all',
                compare ? 'left-3' : 'left-0.5',
              )}
            />
          </span>
          Comparar con el período anterior
        </button>

        {metric.inOut && (
          <button
            type="button"
            aria-pressed={inOut}
            onClick={() => setInOut((v) => !v)}
            className={clsx(btn, 'px-2.5', inOut && 'bg-primary-soft text-primary-ink')}
          >
            Entradas y salidas
          </button>
        )}

        <div className="ml-auto flex items-center gap-0.5">
          <div className={tools}>
            {zoomed && (
              <button type="button" onClick={() => setZoom(null)} className={clsx(btn, 'px-2.5')}>
                <RotateCcw className="h-3.5 w-3.5" aria-hidden />
                Restablecer
              </button>
            )}
            <button
              type="button"
              className={btn}
              aria-label="Acercar"
              title="Acercar (+)"
              disabled={visibleLen <= 4}
              onClick={() => applyZoom(0.5)}
            >
              <Plus className="h-3.5 w-3.5" aria-hidden />
            </button>
            <button
              type="button"
              className={btn}
              aria-label="Alejar"
              title="Alejar (-)"
              disabled={!zoomed}
              onClick={() => applyZoom(2)}
            >
              <Minus className="h-3.5 w-3.5" aria-hidden />
            </button>
          </div>
          <Link
            href={ask}
            className={clsx(btn, 'px-2.5 text-primary-ink')}
            title="Pregúntale a Cortex"
          >
            <Sparkles className="h-3.5 w-3.5" aria-hidden />
            <span className="hidden sm:inline">Pregúntale a Cortex</span>
            <span className="sr-only sm:hidden">Pregúntale a Cortex sobre esta gráfica</span>
          </Link>
          <div className="relative">
            <button
              type="button"
              className={btn}
              aria-label="Descargar"
              aria-haspopup="menu"
              aria-expanded={menu}
              title="Descargar"
              onClick={() => setMenu((m) => !m)}
            >
              <Download className="h-3.5 w-3.5" aria-hidden />
            </button>
            {menu && (
              <div
                role="menu"
                className="absolute right-0 top-9 z-20 w-44 rounded-sm border border-border bg-surface p-1 shadow-pop"
              >
                {(
                  [
                    ['csv', 'Datos (CSV)', doCsv],
                    ['png', 'Imagen (PNG)', () => doImage('png')],
                    ['svg', 'Vector (SVG)', () => doImage('svg')],
                  ] as const
                ).map(([k, label, fn]) => (
                  <button
                    key={k}
                    type="button"
                    role="menuitem"
                    disabled={busy}
                    onClick={fn}
                    className="flex w-full items-center rounded-sm px-3 py-2 text-left text-xs font-semibold text-ink hover:bg-surface-2 disabled:opacity-50"
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      <CartesianChart
        key={`${metric.id}-${rangeId}`}
        className="mt-2"
        height={height}
        labels={chart.labels}
        titles={chart.titles}
        lines={chart.lines}
        bars={chart.bars}
        barMode="stacked"
        threshold={metric.threshold}
        markers={chart.markers}
        nowIndex={chart.now}
        nowLabel="hoy"
        selectedIndex={drill !== null ? drill - off : null}
        onSelect={metric.records ? (i) => setDrill(i + off) : undefined}
        formatAxis={fmt.axis}
        formatValue={fmt.value}
        ariaLabel={aria}
        emptyNote="Todavía no hay datos de esto en este período"
        tooltipHint={metric.records ? 'Clic para ver los registros' : undefined}
        tooltipExtra={(i) =>
          compare && prevBuckets[i + off] ? (
            <span className="block">vs. {prevBuckets[i + off]?.title}</span>
          ) : null
        }
        onBrush={(a, b) => setZoom(brushToZoom(z, [a, b]))}
        onZoomAt={(i) => applyZoom(0.5, i)}
        onZoomKey={(action, i) =>
          action === 'reset' ? setZoom(null) : applyZoom(action === 'in' ? 0.5 : 2, i ?? undefined)
        }
        zoomNote={zoomNote}
        legend={compare || inOut || !!proj ? true : undefined}
      />

      <p className="mt-1 min-h-4 text-micro text-ink-faint">
        {partial
          ? `Hay datos desde el ${dayLabel(coverageFrom as string)}; antes de eso no hay con qué dibujar.`
          : zoomed
            ? 'Doble clic para acercar más · «Restablecer» vuelve a todo el período.'
            : 'Arrastra sobre el gráfico para acercar un tramo.'}
      </p>

      <DrillSheet
        open={drill !== null && drillBucket !== null}
        onClose={() => setDrill(null)}
        title={`${metric.label} · ${drillBucket?.title ?? ''}`}
        subtitle={
          drillBucket?.future
            ? 'Lo que se espera para este tramo'
            : recKind === 'stock'
              ? 'Lo que seguía abierto al cierre de este tramo'
              : 'Lo que pasó en este tramo'
        }
        rows={drillData.rows}
        total={drillData.total}
        sum={drillData.sum}
        money={fmt.value}
        fullHref={metric.fullHref}
        fullLabel={metric.fullLabel}
        noun={metric.recordsNoun ?? 'registros'}
      />
    </div>
  );
}
