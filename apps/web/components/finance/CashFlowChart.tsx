'use client';

import { type ChartWeek, chartScale, formatMoney, fullMoney } from '@/lib/finance/dashboard-shape';
import { clsx } from 'clsx';
import { useEffect, useId, useRef, useState } from 'react';

/**
 * LAS 13 SEMANAS EN UN DIBUJO.
 *
 * Un solo eje en pesos: lo que entra sube desde el cero, lo que sale baja, y la
 * caja con que cierra cada semana es la línea. El escenario, si hay uno, es una
 * segunda línea punteada; la caja mínima, una raya; la semana más baja lleva
 * su cifra escrita. Pasar el puntero (o el foco del teclado) por una semana
 * muestra sus números; tocarla abre por qué.
 *
 * Accesible: cada semana es un botón con sus cifras en el nombre, y debajo hay
 * una tabla con los mismos números para quien prefiera leerlos.
 */

const PAD = { top: 22, right: 14, bottom: 30, left: 62 };

const COLOR = {
  in: 'rgb(var(--emerald))',
  out: 'rgb(var(--ink-faint) / 0.55)',
  line: 'rgb(var(--primary))',
  scenario: 'rgb(var(--amber))',
  minimum: 'rgb(var(--rose))',
  grid: 'rgb(var(--border))',
  zero: 'rgb(var(--border-strong))',
  surface: 'rgb(var(--surface))',
};

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(720);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setWidth(Math.max(280, Math.round(el.getBoundingClientRect().width)));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

/** Una barra con la punta redondeada lejos del cero y plana sobre él. */
function bar(x: number, y0: number, y1: number, w: number): string {
  const h = Math.abs(y1 - y0);
  if (h < 0.5) return '';
  const r = Math.min(4, w / 2, h);
  if (y1 < y0) {
    // Hacia arriba.
    return `M${x},${y0}V${y1 + r}Q${x},${y1} ${x + r},${y1}H${x + w - r}Q${x + w},${y1} ${x + w},${y1 + r}V${y0}Z`;
  }
  return `M${x},${y0}V${y1 - r}Q${x},${y1} ${x + r},${y1}H${x + w - r}Q${x + w},${y1} ${x + w},${y1 - r}V${y0}Z`;
}

export function CashFlowChart({
  weeks,
  currency,
  minimumCash,
  scenarioLabel,
  selected,
  onSelect,
}: {
  weeks: ChartWeek[];
  currency: string;
  minimumCash: number | null;
  scenarioLabel: string | null;
  selected: string | null;
  onSelect: (start: string) => void;
}) {
  const [box, width] = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);
  const titleId = useId();
  const compact = width < 560;
  const height = compact ? 250 : 300;
  const plotW = width - PAD.left - PAD.right;
  const plotH = height - PAD.top - PAD.bottom;
  const n = Math.max(weeks.length, 1);
  const col = plotW / n;
  const scale = chartScale(weeks, minimumCash);
  const y = (v: number) => PAD.top + ((scale.max - v) / (scale.max - scale.min)) * plotH;
  const cx = (i: number) => PAD.left + col * i + col / 2;
  const bw = Math.max(3, Math.min(14, col * 0.3));
  const fm = (v: number) => formatMoney(v, currency);
  const hasScenario = weeks.some((w) => w.scenarioClosing != null);
  const linePath = weeks.map((w, i) => `${i === 0 ? 'M' : 'L'}${cx(i)},${y(w.closing)}`).join('');
  const scenarioPath = hasScenario
    ? weeks
        .map((w, i) => `${i === 0 ? 'M' : 'L'}${cx(i)},${y(w.scenarioClosing ?? w.closing)}`)
        .join('')
    : '';
  const lowestIndex = weeks.findIndex((w) => w.lowest);
  const scenarioLowestIndex = weeks.findIndex((w) => w.scenarioLowest);
  const labelEvery = compact ? 3 : weeks.length > 9 ? 2 : 1;
  const shown = active ?? null;
  const tip = shown != null ? weeks[shown] : null;

  return (
    <div>
      <ul
        className="mb-3 flex flex-wrap gap-x-4 gap-y-1.5 text-micro text-ink-muted"
        aria-label="Leyenda"
      >
        <Legend swatch={<span className="h-2.5 w-2.5 rounded" style={{ background: COLOR.in }} />}>
          Entra
        </Legend>
        <Legend swatch={<span className="h-2.5 w-2.5 rounded" style={{ background: COLOR.out }} />}>
          Sale
        </Legend>
        <Legend
          swatch={<span className="h-0.5 w-4 rounded-pill" style={{ background: COLOR.line }} />}
        >
          Caja al cierre
        </Legend>
        {hasScenario && (
          <Legend
            swatch={
              <span
                className="h-0 w-4 border-t-2 border-dashed"
                style={{ borderColor: COLOR.scenario }}
              />
            }
          >
            {scenarioLabel ? `Escenario «${scenarioLabel}»` : 'Escenario'}
          </Legend>
        )}
        {minimumCash != null && (
          <Legend
            swatch={
              <span
                className="h-0 w-4 border-t border-dashed"
                style={{ borderColor: COLOR.minimum }}
              />
            }
          >
            Caja mínima {fm(minimumCash)}
          </Legend>
        )}
      </ul>

      <div ref={box} className="relative w-full" style={{ height }}>
        <svg
          width={width}
          height={height}
          className="block overflow-visible"
          role="img"
          aria-labelledby={titleId}
        >
          <title id={titleId}>
            {`Caja de las próximas ${weeks.length} semanas: entradas, salidas y caja al cierre de cada semana. La tabla de abajo trae las mismas cifras.`}
          </title>
          {/* Rejilla y eje */}
          {scale.ticks.map((t) => (
            <g key={t}>
              <line
                x1={PAD.left}
                x2={width - PAD.right}
                y1={y(t)}
                y2={y(t)}
                stroke={t === 0 ? COLOR.zero : COLOR.grid}
                strokeWidth={1}
              />
              <text
                x={PAD.left - 8}
                y={y(t)}
                dy="0.32em"
                textAnchor="end"
                className="fill-ink-faint font-mono text-micro"
              >
                {fm(t)}
              </text>
            </g>
          ))}
          {/* Semana activa o abierta */}
          {weeks.map((w, i) =>
            i === shown || w.start === selected ? (
              <rect
                key={`bg-${w.start}`}
                x={PAD.left + col * i + 1}
                y={PAD.top}
                width={col - 2}
                height={plotH}
                rx={8}
                className="fill-primary/10"
              />
            ) : null,
          )}
          {/* Barras */}
          {weeks.map((w, i) => {
            const x = cx(i);
            return (
              <g key={w.start}>
                <path d={bar(x - bw - 1, y(0), y(w.inflows), bw)} fill={COLOR.in} />
                <path d={bar(x + 1, y(0), y(-w.outflows), bw)} fill={COLOR.out} />
              </g>
            );
          })}
          {/* Caja mínima */}
          {minimumCash != null && (
            <line
              x1={PAD.left}
              x2={width - PAD.right}
              y1={y(minimumCash)}
              y2={y(minimumCash)}
              stroke={COLOR.minimum}
              strokeWidth={1.25}
              strokeDasharray="5 4"
            />
          )}
          {/* Líneas */}
          {hasScenario && (
            <path
              d={scenarioPath}
              fill="none"
              stroke={COLOR.scenario}
              strokeWidth={2}
              strokeDasharray="6 4"
              strokeLinejoin="round"
            />
          )}
          <path
            d={linePath}
            fill="none"
            stroke={COLOR.line}
            strokeWidth={2}
            strokeLinejoin="round"
          />
          {weeks.map((w, i) => (
            <circle
              key={`dot-${w.start}`}
              cx={cx(i)}
              cy={y(w.closing)}
              r={i === lowestIndex ? 5 : 3.5}
              fill={w.closing < 0 || w.belowMinimum ? COLOR.minimum : COLOR.line}
              stroke={COLOR.surface}
              strokeWidth={2}
            />
          ))}
          {hasScenario &&
            weeks.map((w, i) =>
              w.scenarioClosing != null ? (
                <circle
                  key={`sdot-${w.start}`}
                  cx={cx(i)}
                  cy={y(w.scenarioClosing)}
                  r={i === scenarioLowestIndex ? 5 : 3}
                  fill={COLOR.scenario}
                  stroke={COLOR.surface}
                  strokeWidth={2}
                />
              ) : null,
            )}
          {/* La semana más baja, escrita */}
          {lowestIndex >= 0 && (
            <LowLabel
              x={cx(lowestIndex)}
              y={y((weeks[lowestIndex] as ChartWeek).closing)}
              width={width}
              text={`Más baja: ${fm((weeks[lowestIndex] as ChartWeek).closing)}`}
              above={!hasScenario || scenarioLowestIndex !== lowestIndex}
            />
          )}
          {hasScenario && scenarioLowestIndex >= 0 && (
            <LowLabel
              x={cx(scenarioLowestIndex)}
              y={y((weeks[scenarioLowestIndex] as ChartWeek).scenarioClosing ?? 0)}
              width={width}
              text={`Escenario: ${fm((weeks[scenarioLowestIndex] as ChartWeek).scenarioClosing ?? 0)}`}
              above={false}
              tone="scenario"
            />
          )}
          {/* Eje de semanas */}
          {weeks.map((w, i) =>
            i % labelEvery === 0 ? (
              <text
                key={`x-${w.start}`}
                x={cx(i)}
                y={height - 8}
                textAnchor="middle"
                className="fill-ink-faint font-mono text-micro"
              >
                {w.label}
              </text>
            ) : null,
          )}
        </svg>

        {/* Una franja tocable por semana, encima del dibujo. */}
        <div
          className="absolute"
          style={{ left: PAD.left, top: PAD.top, width: plotW, height: plotH }}
          onMouseLeave={() => setActive(null)}
        >
          {weeks.map((w, i) => (
            <button
              key={w.start}
              type="button"
              className="absolute top-0 h-full rounded-[8px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              style={{ left: col * i, width: col }}
              aria-label={`Semana del ${w.label}: entran ${fm(w.inflows)}, salen ${fm(w.outflows)}, cierra con ${fm(w.closing)}${w.scenarioClosing != null ? `; con el escenario, ${fm(w.scenarioClosing)}` : ''}${w.lowest ? '. Es la semana más baja' : ''}. Abrir el detalle.`}
              aria-pressed={selected === w.start}
              onMouseEnter={() => setActive(i)}
              onFocus={() => setActive(i)}
              onBlur={() => setActive(null)}
              onClick={() => onSelect(w.start)}
            />
          ))}
        </div>

        {tip && shown != null && (
          <div
            className="pointer-events-none absolute z-10 w-48 rounded-sm border border-border bg-surface px-3 py-2 text-micro shadow-pop"
            style={{
              left: Math.min(Math.max(cx(shown) - 96, 4), width - 196),
              top: 0,
            }}
            aria-hidden
          >
            <p className="mb-1 font-semibold text-ink">Semana del {tip.label}</p>
            <TipRow label="Entra" value={fm(tip.inflows)} />
            <TipRow label="Sale" value={fm(tip.outflows)} />
            <TipRow label="Cierra" value={fm(tip.closing)} strong />
            {tip.scenarioClosing != null && (
              <TipRow label="Escenario" value={fm(tip.scenarioClosing)} />
            )}
            <p className="mt-1 text-ink-faint">Toca para ver por qué</p>
          </div>
        )}
      </div>

      <details className="mt-3 text-xs">
        <summary className="cursor-pointer select-none font-semibold text-ink-muted hover:text-ink">
          Ver como tabla
        </summary>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-[480px] text-left">
            <caption className="sr-only">Caja por semana</caption>
            <thead className="text-micro text-ink-faint">
              <tr>
                <th scope="col" className="py-1.5 pr-3 font-semibold">
                  Semana
                </th>
                <th scope="col" className="py-1.5 pr-3 text-right font-semibold">
                  Entra
                </th>
                <th scope="col" className="py-1.5 pr-3 text-right font-semibold">
                  Sale
                </th>
                <th scope="col" className="py-1.5 pr-3 text-right font-semibold">
                  Cierra
                </th>
                {hasScenario && (
                  <th scope="col" className="py-1.5 text-right font-semibold">
                    Escenario
                  </th>
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-border/70">
              {weeks.map((w) => (
                <tr key={w.start} className={clsx(w.lowest && 'bg-amber-soft/60')}>
                  <th scope="row" className="py-1.5 pr-3 font-medium text-ink">
                    <button
                      type="button"
                      className="hover:text-primary hover:underline"
                      onClick={() => onSelect(w.start)}
                    >
                      {w.label}
                    </button>
                    {w.lowest && <span className="ml-1.5 text-micro text-amber">más baja</span>}
                  </th>
                  <td className="tabular py-1.5 pr-3 text-right font-mono">
                    {fullMoney(w.inflows, currency)}
                  </td>
                  <td className="tabular py-1.5 pr-3 text-right font-mono">
                    {fullMoney(w.outflows, currency)}
                  </td>
                  <td
                    className={clsx(
                      'tabular py-1.5 pr-3 text-right font-mono font-semibold',
                      w.closing < 0 ? 'text-rose' : 'text-ink',
                    )}
                  >
                    {fullMoney(w.closing, currency)}
                  </td>
                  {hasScenario && (
                    <td className="tabular py-1.5 text-right font-mono">
                      {w.scenarioClosing != null ? fullMoney(w.scenarioClosing, currency) : '—'}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}

function Legend({ swatch, children }: { swatch: React.ReactNode; children: React.ReactNode }) {
  return (
    <li className="inline-flex items-center gap-1.5">
      <span className="inline-flex w-4 items-center justify-center" aria-hidden>
        {swatch}
      </span>
      {children}
    </li>
  );
}

function TipRow({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <p className="flex justify-between gap-3">
      <span className="text-ink-muted">{label}</span>
      <span className={clsx('tabular font-mono', strong ? 'font-semibold text-ink' : 'text-ink')}>
        {value}
      </span>
    </p>
  );
}

function LowLabel({
  x,
  y,
  width,
  text,
  above,
  tone = 'base',
}: {
  x: number;
  y: number;
  width: number;
  text: string;
  above: boolean;
  tone?: 'base' | 'scenario';
}) {
  const w = text.length * 7.3 + 16;
  const left = Math.min(Math.max(x - w / 2, PAD.left), width - PAD.right - w);
  const top = above ? y - 28 : y + 10;
  return (
    <g aria-hidden>
      <rect
        x={left}
        y={top}
        width={w}
        height={19}
        rx={9.5}
        fill="rgb(var(--surface))"
        stroke={tone === 'scenario' ? COLOR.scenario : COLOR.line}
        strokeWidth={1}
      />
      <text
        x={left + w / 2}
        y={top + 13}
        textAnchor="middle"
        className="fill-ink font-mono text-micro font-semibold"
      >
        {text}
      </text>
    </g>
  );
}
