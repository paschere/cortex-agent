import { DeltaPill } from '@/components/charts/DeltaPill';
import { Sparkline } from '@/components/charts/Sparkline';
import { CHART_COLOR } from '@/components/charts/colors';
import type { AreaKpi } from '@/lib/area-kpis';
import { clsx } from 'clsx';
import Link from 'next/link';

/**
 * LA FRANJA DE CIFRAS DE ARRIBA DE UN ÁREA.
 *
 * Tres a cinco cifras en serif, cada una con su tendencia (si hay serie) y su
 * cambio, y cada una lleva a la pestaña donde se trabaja. Sólo dibuja lo que la
 * página ya leyó (`lib/area-kpis.ts`); sin cifras no ocupa sitio.
 */

const BAR: Record<NonNullable<AreaKpi['tone']>, string> = {
  primary: 'bg-primary',
  emerald: 'bg-emerald',
  amber: 'bg-amber',
  sky: 'bg-sky',
  rose: 'bg-rose',
};

export function AreaKpiStrip({
  kpis,
  hrefOf = (h) => h,
  label = 'Cifras del área',
}: {
  kpis: AreaKpi[];
  /** Cómo escribir la ruta de cada tarjeta (p. ej. dentro de un espacio de trabajo). */
  hrefOf?: (href: string) => string;
  label?: string;
}) {
  if (kpis.length === 0) return null;
  return (
    <section
      aria-label={label}
      data-kpi-strip=""
      className={clsx(
        'mb-6 grid grid-cols-1 gap-3 min-[560px]:grid-cols-2 print:hidden',
        kpis.length >= 5
          ? 'lg:grid-cols-3 xl:grid-cols-5'
          : kpis.length === 4
            ? 'lg:grid-cols-4'
            : 'lg:grid-cols-3',
      )}
    >
      {kpis.map((k) => {
        const tone = k.tone ?? 'primary';
        return (
          <Link
            key={k.key}
            href={hrefOf(k.href)}
            className="group relative flex min-w-0 flex-col gap-1 overflow-hidden rounded-card border border-border bg-surface px-4 pb-3 pt-3.5 shadow-card transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 motion-reduce:transition-none"
          >
            <span
              aria-hidden
              className={clsx('absolute inset-y-3 left-0 w-[3px] rounded-r-full', BAR[tone])}
            />
            <span className="truncate text-micro font-semibold text-ink-muted">{k.label}</span>
            <span className="stat-display text-[26px] text-ink md:text-[28px]">{k.value}</span>
            <span className="flex min-h-[20px] flex-wrap items-center gap-x-2 gap-y-0.5">
              {k.delta ? (
                <DeltaPill
                  ratio={k.delta.ratio}
                  good={k.delta.good}
                  compact
                  label={k.delta.label}
                />
              ) : null}
              {k.hint ? <span className="truncate text-micro text-ink-faint">{k.hint}</span> : null}
            </span>
            {k.spark ? (
              <Sparkline
                values={k.spark.values}
                labels={k.spark.labels}
                format={k.spark.format}
                name={k.label}
                color={CHART_COLOR[tone]}
                height={30}
                className="mt-1"
              />
            ) : null}
          </Link>
        );
      })}
    </section>
  );
}
