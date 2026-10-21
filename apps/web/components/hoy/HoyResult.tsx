'use client';

import { CartesianChart } from '@/components/charts/CartesianChart';
import { DeltaPill } from '@/components/charts/DeltaPill';
import { CHART_COLOR } from '@/components/charts/colors';
import { metricFormatters } from '@/components/charts/metric-format';
import type { ResultView } from '@/lib/hoy/insights';
import { clsx } from 'clsx';
import { useMemo } from 'react';
import { SectionHead } from './SectionHead';

/**
 * «CÓMO VA EL MES»: ingresos contra gastos de los últimos meses (barras) y la
 * utilidad (línea), con las tres cifras del mes y su cambio contra el mes
 * anterior y, si Siigo ya tenía cifras, contra el mismo mes del año pasado.
 * Sale de los estados de resultados de Siigo (base causación). Sólo lo ve
 * quien administra: incluye la nómina sumada.
 */
export function HoyResult({ result }: { result: ResultView }) {
  const fmt = useMemo(
    () => metricFormatters({ fmt: 'money', currency: result.currency }),
    [result.currency],
  );
  const { current: c, months } = result;
  const loss = c.profit < 0;
  // Medio mes contra un mes entero no es bueno ni malo: los cambios van en gris mientras sigue en curso.
  const neutral = c.inProgress;
  return (
    <section aria-label="Resultado del mes" className="flex min-w-0 flex-col gap-3">
      <SectionHead
        title={`Cómo va ${result.monthName}`}
        hint="Ingresos, gastos y utilidad según Siigo"
        href={result.href}
        hrefLabel="Abrir Estados"
      />

      <dl className="m-0 divide-y divide-border rounded-card border border-border bg-surface">
        <Figure
          label="Ingresos"
          value={fmt.value(c.income)}
          tone="emerald"
          vsPrev={result.incomeVsPrev}
          vsYear={result.incomeVsYear}
          goodWhenUp
          neutral={neutral}
          prevName={result.prevName}
          yearLabel={result.yearAgo ? result.monthName : null}
        />
        <Figure
          label="Gastos"
          value={fmt.value(c.expenses)}
          tone="amber"
          vsPrev={result.expensesVsPrev}
          vsYear={null}
          goodWhenUp={false}
          neutral={neutral}
          prevName={result.prevName}
          yearLabel={null}
        />
        <Figure
          label={loss ? 'Pérdida' : 'Utilidad'}
          value={fmt.value(c.profit)}
          tone={loss ? 'rose' : 'primary'}
          vsPrev={result.profitVsPrev}
          vsYear={result.profitVsYear}
          goodWhenUp
          neutral={neutral}
          prevName={result.prevName}
          yearLabel={result.yearAgo ? result.monthName : null}
        />
      </dl>

      <CartesianChart
        labels={months.map((m) => m.label)}
        titles={months.map((m) => (m.inProgress ? `${m.label} (en curso)` : m.label))}
        bars={[
          {
            id: 'ingresos',
            label: 'Ingresos',
            color: CHART_COLOR.emerald,
            values: months.map((m) => m.income),
            dim: months.flatMap((m, i) => (m.inProgress ? [i] : [])),
          },
          {
            id: 'gastos',
            label: 'Gastos',
            color: CHART_COLOR.amber,
            values: months.map((m) => m.expenses),
            dim: months.flatMap((m, i) => (m.inProgress ? [i] : [])),
          },
        ]}
        barMode="grouped"
        lines={[
          {
            id: 'utilidad',
            label: 'Utilidad',
            color: CHART_COLOR.primary,
            values: months.map((m) => m.profit),
            dots: true,
            curve: 'linear',
          },
        ]}
        formatAxis={fmt.axis}
        formatValue={fmt.value}
        ariaLabel={`Ingresos, gastos y utilidad de los últimos ${months.length} meses`}
        height={240}
        legend
      />
      {c.inProgress && (
        <p className="text-micro text-ink-faint">
          {result.monthName[0]?.toUpperCase()}
          {result.monthName.slice(1)} sigue en curso (más claro en el gráfico): sus costos pueden
          llegar después, así que la utilidad aún puede bajar
          {result.prevName ? `; lo justo es compararlo con ${result.prevName} completo` : ''}.
        </p>
      )}
    </section>
  );
}

function Figure({
  label,
  value,
  tone,
  vsPrev,
  vsYear,
  goodWhenUp,
  neutral,
  prevName,
  yearLabel,
}: {
  label: string;
  value: string;
  tone: 'emerald' | 'amber' | 'rose' | 'primary';
  vsPrev: number | null;
  vsYear: number | null;
  goodWhenUp: boolean;
  neutral: boolean;
  prevName: string | null;
  yearLabel: string | null;
}) {
  const good = (r: number | null) =>
    neutral || r === null || Math.abs(r) < 0.005 ? null : r >= 0 === goodWhenUp;
  return (
    <div className="flex min-w-0 items-center justify-between gap-3 px-3 py-2.5">
      <div className="flex min-w-0 flex-col gap-1">
        <dt className="flex items-center gap-1.5 text-xs font-semibold text-ink-muted">
          <span
            aria-hidden
            className={clsx(
              'h-2 w-2 rounded-pill',
              tone === 'emerald'
                ? 'bg-emerald'
                : tone === 'amber'
                  ? 'bg-amber'
                  : tone === 'rose'
                    ? 'bg-rose'
                    : 'bg-primary',
            )}
          />
          {label}
        </dt>
        <dd className="m-0 flex flex-wrap gap-x-3 gap-y-1">
          {vsPrev !== null && prevName && (
            <DeltaPill
              ratio={vsPrev}
              good={good(vsPrev)}
              compact
              label={`vs. ${prevName}${neutral ? ' completo' : ''}`}
            />
          )}
          {vsYear !== null && yearLabel && (
            <DeltaPill
              ratio={vsYear}
              good={good(vsYear)}
              compact
              label={`vs. ${yearLabel} del año pasado`}
            />
          )}
        </dd>
      </div>
      <span className="stat-display shrink-0 text-lg leading-tight tabular-nums text-ink sm:text-xl">
        {value}
      </span>
    </div>
  );
}
