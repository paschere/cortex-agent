'use client';

import { type ChartWeek, formatMoney, fullMoney } from '@/lib/finance/dashboard-shape';
import { clsx } from 'clsx';
import { CartesianChart } from '../charts/CartesianChart';
import { CHART_COLOR } from '../charts/colors';
import { formatCompact } from '../charts/scales';

/**
 * LAS 13 SEMANAS EN UN DIBUJO.
 *
 * Un solo eje en pesos: lo que entra sube desde el cero, lo que sale baja, y la
 * caja con que cierra cada semana es la línea. El escenario, si hay uno, es una
 * segunda línea punteada; la caja mínima, una raya rosa con su franja debajo; la
 * semana más baja lleva su ficha. Pasar el puntero (o las flechas del teclado)
 * por una semana muestra sus números; tocarla (o Enter) abre por qué.
 *
 * Está hecho con el kit de `components/charts`: este archivo sólo traduce las
 * semanas a series. Accesible: el gráfico dice su tendencia en una frase y
 * debajo hay una tabla con los mismos números para quien prefiera leerlos.
 */

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
  const hasScenario = weeks.some((w) => w.scenarioClosing != null);
  const fm = (v: number) => formatMoney(v, currency);
  const isCop = currency.toUpperCase() === 'COP';
  const axis = (v: number) =>
    isCop ? formatCompact(v, { money: true }) : formatCompact(v, { suffix: ` ${currency}` });
  const lowestIndex = weeks.findIndex((w) => w.lowest);
  const scenarioLowestIndex = weeks.findIndex((w) => w.scenarioLowest);
  const selectedIndex = selected ? weeks.findIndex((w) => w.start === selected) : -1;

  const markers = (() => {
    const out = [];
    if (lowestIndex >= 0) {
      out.push({
        index: lowestIndex,
        label: `Más baja ${axis((weeks[lowestIndex] as ChartWeek).closing)}`,
        color: CHART_COLOR.amber,
      });
    }
    if (hasScenario && scenarioLowestIndex >= 0 && scenarioLowestIndex !== lowestIndex) {
      out.push({
        index: scenarioLowestIndex,
        label: `Escenario ${axis((weeks[scenarioLowestIndex] as ChartWeek).scenarioClosing ?? 0)}`,
        color: CHART_COLOR.amber,
      });
    }
    return out;
  })();

  return (
    <div>
      <CartesianChart
        labels={weeks.map((w) => w.label)}
        titles={weeks.map((w) => `Semana del ${w.label}`)}
        barMode="stacked"
        bars={[
          {
            id: 'in',
            label: 'Entra',
            color: CHART_COLOR.emerald,
            values: weeks.map((w) => w.inflows),
            display: weeks.map((w) => fullMoney(w.inflows, currency)),
          },
          {
            id: 'out',
            label: 'Sale',
            color: 'rgb(var(--ink-faint) / 0.55)',
            values: weeks.map((w) => -w.outflows),
            display: weeks.map((w) => fullMoney(w.outflows, currency)),
          },
        ]}
        lines={[
          {
            id: 'closing',
            label: 'Caja al cierre',
            color: CHART_COLOR.primary,
            values: weeks.map((w) => w.closing),
            display: weeks.map((w) => fullMoney(w.closing, currency)),
            dots: true,
            dotColor: (i) => {
              const w = weeks[i];
              return w && (w.closing < 0 || w.belowMinimum) ? CHART_COLOR.rose : undefined;
            },
          },
          ...(hasScenario
            ? [
                {
                  id: 'scenario',
                  label: scenarioLabel ? `Escenario «${scenarioLabel}»` : 'Escenario',
                  color: CHART_COLOR.amber,
                  dashed: true,
                  values: weeks.map((w) => w.scenarioClosing),
                  display: weeks.map((w) =>
                    w.scenarioClosing != null ? fullMoney(w.scenarioClosing, currency) : '—',
                  ),
                },
              ]
            : []),
        ]}
        threshold={minimumCash != null ? { value: minimumCash, label: 'Caja mínima' } : undefined}
        markers={markers}
        selectedIndex={selectedIndex >= 0 ? selectedIndex : null}
        onSelect={(i) => {
          const w = weeks[i];
          if (w) onSelect(w.start);
        }}
        formatAxis={axis}
        formatValue={(v) => fullMoney(v, currency)}
        height={weeks.length > 9 ? 320 : 300}
        tooltipHint="Toca para ver por qué"
        ariaLabel={`Caja de las próximas ${weeks.length} semanas: entradas, salidas y caja al cierre de cada semana. Con las flechas se recorre semana por semana. La tabla de abajo trae las mismas cifras.`}
      />

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
