'use client';

import { DeltaPill } from '@/components/charts/DeltaPill';
import { MetricChart } from '@/components/charts/MetricChart';
import { Sparkline } from '@/components/charts/Sparkline';
import { CHART_COLOR } from '@/components/charts/colors';
import { metricFormatters } from '@/components/charts/metric-format';
import type { MetricModel } from '@/components/charts/metric-types';
import type { KpiView } from '@/lib/hoy/shape';
import { clsx } from 'clsx';
import { useState } from 'react';

/**
 * LA CIFRA GRANDE Y SU GRÁFICO, con la tira de indicadores debajo. Por defecto
 * es la caja: un número en serif y una línea con su proyección. Tocar otro
 * indicador cambia la cifra y el gráfico a esa métrica; todo lo demás
 * (rango, comparar, acercar, preguntar, descargar) vive en el propio gráfico.
 */
export function HoyHero({
  metrics,
  kpis,
  today,
}: {
  metrics: MetricModel[];
  kpis: KpiView[];
  today: string;
}) {
  const [selected, setSelected] = useState(metrics[0]?.id ?? '');
  const metric = metrics.find((m) => m.id === selected) ?? metrics[0];
  if (!metric) return null;
  const kpi = kpis.find((k) => k.id === metric.id);
  const fmt = metricFormatters(metric);

  return (
    <section aria-label="Tus números" className="flex flex-col gap-5">
      <div id="hoy-grafica">
        <MetricChart
          key={metric.id}
          metric={metric}
          today={today}
          defaultRange="30d"
          height={250}
          renderHeader={(info) => {
            const headline =
              kpi?.value ?? (info.summary.current === null ? '—' : fmt.value(info.summary.current));
            return (
              <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
                <div className="flex min-w-0 flex-col gap-1">
                  <span className="text-sm text-ink-faint">{metric.hint ?? metric.label}</span>
                  <span
                    className="stat-display text-[2.6rem] leading-none text-ink sm:text-[3.25rem]"
                    aria-live="polite"
                  >
                    {headline}
                  </span>
                </div>
                <DeltaPill
                  ratio={info.summary.ratio}
                  good={
                    info.summary.ratio === null || Math.abs(info.summary.ratio) < 0.005
                      ? null
                      : info.summary.ratio >= 0 === metric.goodWhenUp
                  }
                  label={
                    metric.kind === 'stock'
                      ? `desde el inicio de ${info.range.phrase}`
                      : 'vs. el período anterior'
                  }
                />
              </div>
            );
          }}
        />
      </div>

      <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5" aria-label="Indicadores">
        {kpis.map((k) => {
          const on = k.id === metric.id;
          return (
            <li key={k.id} className="min-w-0">
              <button
                type="button"
                aria-pressed={on}
                onClick={() => {
                  setSelected(k.id);
                  document
                    .getElementById('hoy-grafica')
                    ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
                }}
                className={clsx(
                  'flex w-full flex-col gap-1.5 rounded-card border bg-surface p-3 text-left transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary/40',
                  on ? 'border-primary/50 shadow-card' : 'border-border hover:border-border-strong',
                )}
              >
                <span className="flex items-center gap-1.5 text-xs font-semibold text-ink-muted">
                  {k.alert && <span aria-hidden className="h-1.5 w-1.5 rounded-pill bg-rose" />}
                  <span className="truncate">{k.label}</span>
                  {k.alert && <span className="sr-only">(pide atención)</span>}
                </span>
                <span className="stat-display truncate text-xl leading-tight text-ink">
                  {k.value}
                </span>
                <Sparkline
                  values={k.spark}
                  labels={k.sparkLabels}
                  color={CHART_COLOR[k.tone]}
                  height={28}
                  name={k.label}
                />
                <span title={k.deltaLabel}>
                  <DeltaPill ratio={k.ratio} good={k.good} compact />
                  <span className="sr-only"> {k.deltaLabel}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
