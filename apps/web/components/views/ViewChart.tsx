'use client';

import type { ComputedBlock } from '@cortex/agent-tools';
import { clsx } from 'clsx';
import { BarChart3 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { AreaChart } from '../charts/AreaChart';
import { RankBars } from '../charts/RankBars';
import { axisFormatterFor } from '../charts/scales';
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
  if (block.chart === 'funnel') return <Funnel block={block} />;
  if (block.chart === 'heatmap' && block.heat) return <Heatmap block={block} heat={block.heat} />;
  if (block.chart === 'donut') return <Donut block={block} />;
  if (block.chart === 'line') return <Line block={block} />;
  return <Bars block={block} />;
}

/**
 * EMBUDO. Una barra centrada por etapa, cada una proporcional a la primera, y
 * entre etapa y etapa el porcentaje que pasó a la siguiente: dice dónde se cae
 * la gente, que es para lo que se mira un embudo. Las etapas vacías se
 * muestran (con su cero), no se esconden.
 */
function Funnel({ block }: { block: Chart }) {
  const color = TONE_COLOR[block.tone];
  const top = Math.max(...block.points.map((p) => p.value), 0) || 1;
  return (
    <ol className="space-y-2" aria-label={`${block.title}: embudo por etapas`}>
      {block.points.map((p, i) => {
        const prev = i > 0 ? block.points[i - 1] : undefined;
        const step = prev && prev.value > 0 ? (p.value / prev.value) * 100 : null;
        return (
          <li key={p.label}>
            {step !== null && (
              <p className="tabular py-0.5 text-center font-mono text-micro text-ink-faint">
                <span aria-hidden>↓ </span>
                {SHARE.format(step)} % pasa a «{p.label}»
              </p>
            )}
            <div className="mb-1 flex items-baseline justify-between gap-3 text-xs">
              <span className="min-w-0 truncate font-medium text-ink">{p.label}</span>
              <span className="tabular shrink-0 font-mono font-semibold text-ink">{p.display}</span>
            </div>
            <div
              className="view-grow-x mx-auto h-7 rounded-sm"
              title={`${p.label}: ${p.display}`}
              style={{
                width: `${Math.max((Math.max(p.value, 0) / top) * 100, p.value > 0 ? 6 : 2)}%`,
                background: color,
                opacity: Math.max(0.45, 1 - i * 0.13),
              }}
            />
          </li>
        );
      })}
    </ol>
  );
}

/**
 * MAPA DE CALOR: día de la semana × hora. La intensidad es la del valor sobre
 * el máximo; las celdas vacías quedan en el fondo. El texto equivalente (el
 * rato más cargado y el total por día) va para el lector de pantalla.
 */
const HOURS = Array.from({ length: 24 }, (_, h) => h);

function Heatmap({ block, heat }: { block: Chart; heat: NonNullable<Chart['heat']> }) {
  const color = TONE_COLOR[block.tone];
  let best: { day: string; hour: number; display: string; value: number } | null = null;
  heat.cells.forEach((row, d) =>
    row.forEach((c, h) => {
      if (c.value > (best?.value ?? 0))
        best = { day: heat.rows[d] ?? '', hour: h, display: c.display, value: c.value };
    }),
  );
  const peak = best as { day: string; hour: number; display: string } | null;
  return (
    <figure className="m-0">
      <div className="overflow-x-auto pb-1">
        <div className="min-w-[26rem]">
          <div
            className="grid items-center gap-[3px]"
            style={{ gridTemplateColumns: 'auto repeat(24, minmax(0, 1fr))' }}
            role="img"
            aria-label={
              peak
                ? `${block.title}: mapa de calor por día y hora. Lo más alto: ${peak.day} a las ${peak.hour} h, ${peak.display}.`
                : `${block.title}: mapa de calor sin datos`
            }
          >
            <span aria-hidden />
            {HOURS.map((h) => (
              <span
                key={`h${h}`}
                aria-hidden
                className="text-center text-[0.6rem] leading-none text-ink-faint"
              >
                {h % 3 === 0 ? h : ''}
              </span>
            ))}
            {heat.cells.map((row, d) => (
              <HeatRow
                key={heat.rows[d]}
                label={heat.rows[d] ?? ''}
                row={row}
                max={heat.max}
                color={color}
              />
            ))}
          </div>
        </div>
      </div>
      <figcaption className="mt-2 flex items-center justify-between text-micro text-ink-faint">
        <span>Horas del día (0–23)</span>
        <span className="inline-flex items-center gap-1.5" aria-hidden>
          menos
          {[0.15, 0.4, 0.65, 0.9].map((o) => (
            <span
              key={o}
              className="view-heat-cell h-2.5 w-4 rounded-[3px]"
              style={{ background: color, opacity: o }}
            />
          ))}
          más
        </span>
        <span className="sr-only">
          {block.points.map((p) => `${p.label}: ${p.display}`).join('; ')}
        </span>
      </figcaption>
    </figure>
  );
}

function HeatRow({
  label,
  row,
  max,
  color,
}: {
  label: string;
  row: Array<{ value: number; display: string }>;
  max: number;
  color: string;
}) {
  return (
    <>
      <span aria-hidden className="pr-1.5 text-right text-micro text-ink-faint">
        {label}
      </span>
      {row.map((c, h) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: la hora ES la posición.
          key={h}
          className="view-heat-cell aspect-square rounded-[3px] bg-surface-2"
          title={c.value ? `${label} ${h}:00 — ${c.display}` : `${label} ${h}:00 — sin datos`}
          style={
            c.value > 0
              ? { background: color, opacity: 0.15 + 0.85 * Math.min(c.value / (max || 1), 1) }
              : undefined
          }
        />
      ))}
    </>
  );
}

const SHARE = new Intl.NumberFormat('es-CO', { maximumFractionDigits: 0 });

function Bars({ block }: { block: Chart }) {
  return (
    <RankBars
      name={block.title}
      color={TONE_COLOR[block.tone]}
      items={block.points.map((p) => ({ label: p.label, value: p.value, display: p.display }))}
    />
  );
}

function Line({ block }: { block: Chart }) {
  const points = block.points;
  const color = TONE_COLOR[block.tone];
  const fmt = useMemo(() => axisFormatterFor(points[0]?.display), [points]);
  const first = points[0];
  const last = points[points.length - 1];
  return (
    <figure className="m-0">
      <AreaChart
        labels={points.map((p) => p.label)}
        lines={[
          {
            id: 'v',
            label: block.title,
            color,
            area: true,
            values: points.map((p) => p.value),
            display: points.map((p) => p.display),
          },
        ]}
        formatAxis={fmt}
        formatValue={fmt}
        height={248}
        legend={false}
        ariaLabel={`${block.title}: de ${first?.display} (${first?.label}) a ${last?.display} (${last?.label}). Con las flechas se recorre punto por punto.`}
      />
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
