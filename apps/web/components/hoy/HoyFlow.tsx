'use client';

import { CartesianChart } from '@/components/charts/CartesianChart';
import { DeltaPill } from '@/components/charts/DeltaPill';
import { CHART_COLOR } from '@/components/charts/colors';
import { metricFormatters } from '@/components/charts/metric-format';
import { type FlowView, flowTotals } from '@/lib/hoy/insights';
import { formatDay } from '@cortex/agent-tools/src/format/display';
import { clsx } from 'clsx';
import { useMemo, useState } from 'react';
import { SectionHead } from './SectionHead';

const RANGES = [4, 8, 13] as const;

/**
 * «LA CAJA, SEMANA A SEMANA»: lo que entra y lo que sale cada semana (barras
 * verdes hacia arriba, rosas hacia abajo) y, encima, el saldo con su rango
 * probable y la raya de la caja mínima. Se elige cuántas semanas mirar (4, 8 o
 * todas) y tocar una barra abre lo que más pesa esa semana. Las cifras llegan
 * como números y se escriben aquí: nada de funciones desde el servidor.
 */
export function HoyFlow({ flow }: { flow: FlowView }) {
  const ranges = RANGES.filter((r) => r <= flow.weeks.length);
  const options =
    ranges.length && ranges.at(-1) === flow.weeks.length ? ranges : [...ranges, flow.weeks.length];
  const [n, setN] = useState<number>(
    options.includes(8) ? 8 : (options.at(-1) ?? flow.weeks.length),
  );
  const [sel, setSel] = useState<number | null>(null);
  const fmt = useMemo(
    () => metricFormatters({ fmt: 'money', currency: flow.currency }),
    [flow.currency],
  );
  const weeks = flow.weeks.slice(0, n);
  const t = flowTotals(flow, n);
  const low = [...weeks].sort((a, b) => a.closing - b.closing)[0];
  const below = flow.minimum !== null && !!low && low.closing < flow.minimum;
  const picked = sel !== null ? weeks[sel] : null;
  const netPicked = picked ? picked.inflow - picked.outflow : 0;

  return (
    <section aria-label="Entradas y salidas de caja" className="flex flex-col gap-3">
      <SectionHead
        title="Entradas y salidas"
        hint="Lo esperado semana a semana, según vencimientos y cómo suele pagar cada cliente"
        href={flow.href}
        hrefLabel="Abrir Finanzas"
        right={
          options.length > 1 ? (
            // biome-ignore lint/a11y/useSemanticElements: un grupo de botones segmentados, no un formulario.
            <div
              role="group"
              aria-label="Cuántas semanas mirar"
              className="flex rounded-pill border border-border bg-surface p-0.5"
            >
              {options.map((r) => (
                <button
                  key={r}
                  type="button"
                  aria-pressed={n === r}
                  onClick={() => {
                    setN(r);
                    setSel(null);
                  }}
                  className={clsx(
                    'rounded-pill px-3 py-1 text-xs font-semibold transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary/40',
                    n === r ? 'bg-primary-soft text-primary-ink' : 'text-ink-muted hover:text-ink',
                  )}
                >
                  {r} sem.
                </button>
              ))}
            </div>
          ) : undefined
        }
      />

      <dl className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <Stat label={`Entra en ${n} semanas`} value={fmt.value(t.inflow)} tone="emerald" />
        <Stat label={`Sale en ${n} semanas`} value={fmt.value(t.outflow)} tone="rose" />
        <Stat
          label="La caja queda en"
          value={fmt.value(t.closing)}
          tone="primary"
          extra={
            <DeltaPill
              ratio={
                flow.startingCash > 0 ? (t.closing - flow.startingCash) / flow.startingCash : null
              }
              good={t.closing >= flow.startingCash}
              compact
              label={`vs. hoy (${fmt.value(flow.startingCash)})`}
            />
          }
        />
      </dl>

      <CartesianChart
        labels={weeks.map((w) => w.label)}
        titles={weeks.map((w) => `Semana del ${formatDay(w.start)}`)}
        bars={[
          {
            id: 'entra',
            label: 'Entra',
            color: CHART_COLOR.emerald,
            values: weeks.map((w) => w.inflow),
          },
          {
            id: 'sale',
            label: 'Sale',
            color: CHART_COLOR.rose,
            values: weeks.map((w) => -w.outflow),
          },
        ]}
        barMode="stacked"
        lines={[
          {
            id: 'caja',
            label: 'Caja al cierre',
            color: CHART_COLOR.primary,
            values: weeks.map((w) => w.closing),
            dots: true,
            curve: 'linear',
            band: {
              lo: weeks.map((w) => w.lo),
              hi: weeks.map((w) => w.hi),
              label: 'Rango probable',
            },
          },
        ]}
        threshold={
          flow.minimum !== null ? { value: flow.minimum, label: 'Caja mínima' } : undefined
        }
        formatAxis={fmt.axis}
        formatValue={fmt.value}
        selectedIndex={sel}
        onSelect={(i) => setSel((cur) => (cur === i ? null : i))}
        tooltipHint="Toca para ver lo que más pesa"
        ariaLabel={`Entradas, salidas y caja al cierre de las próximas ${n} semanas`}
        height={260}
        legend
      />

      {below && low ? (
        <p className="rounded-sm bg-rose-soft px-3 py-2 text-xs text-rose">
          La semana del {formatDay(low.start)} la caja bajaría a {fmt.value(low.closing)}, por
          debajo de tu mínimo ({fmt.value(flow.minimum ?? 0)}).
        </p>
      ) : (
        low && (
          <p className="text-xs text-ink-faint">
            El punto más bajo es la semana del {formatDay(low.start)}, con {fmt.value(low.closing)}
            {flow.minimum !== null ? ', todavía sobre tu mínimo' : ''}.
          </p>
        )
      )}

      {picked && (
        <div className="rounded-card border border-border bg-surface p-3" aria-live="polite">
          <p className="flex flex-wrap items-baseline gap-x-3 text-sm font-semibold text-ink">
            Semana del {formatDay(picked.start)}
            <span className="tabular text-xs font-normal tabular-nums text-ink-faint">
              entra {fmt.value(picked.inflow)} · sale {fmt.value(picked.outflow)} · neto{' '}
              {fmt.value(netPicked)}
            </span>
          </p>
          {picked.top.length > 0 ? (
            <ul className="mt-2 grid gap-1 sm:grid-cols-2">
              {picked.top.map((it) => (
                <li
                  key={`${it.direction}-${it.label}`}
                  className="flex items-baseline justify-between gap-3 text-xs"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span
                      aria-hidden
                      className={clsx(
                        'h-2 w-2 shrink-0 rounded-pill',
                        it.direction === 'in' ? 'bg-emerald' : 'bg-rose',
                      )}
                    />
                    <span className="truncate text-ink-muted">
                      <span className="sr-only">
                        {it.direction === 'in' ? 'Entra: ' : 'Sale: '}
                      </span>
                      {it.label}
                    </span>
                  </span>
                  <span className="tabular shrink-0 tabular-nums font-semibold text-ink">
                    {fmt.value(it.amount)}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-1 text-xs text-ink-faint">No hay movimientos esperados esa semana.</p>
          )}
        </div>
      )}
    </section>
  );
}

function Stat({
  label,
  value,
  tone,
  extra,
}: {
  label: string;
  value: string;
  tone: 'emerald' | 'rose' | 'primary';
  extra?: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-card border border-border bg-surface p-3">
      <dt className="flex items-center gap-1.5 text-xs font-semibold text-ink-muted">
        <span
          aria-hidden
          className={clsx(
            'h-2 w-2 rounded-pill',
            tone === 'emerald' ? 'bg-emerald' : tone === 'rose' ? 'bg-rose' : 'bg-primary',
          )}
        />
        {label}
      </dt>
      <dd className="m-0 flex flex-col gap-1">
        <span className="stat-display text-lg leading-tight tabular-nums text-ink sm:text-xl">
          {value}
        </span>
        {extra}
      </dd>
    </div>
  );
}
