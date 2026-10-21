import { DeltaPill, Sparkline } from '@/components/charts';
import { CHART_COLOR } from '@/components/charts/colors';
import type { OpsKpi } from '@/lib/hoy/ops';
import { clsx } from 'clsx';
import Link from 'next/link';

/**
 * «OPERACIÓN»: LO QUE CORTEX HACE, EN CUATRO CIFRAS.
 *
 * Una fila compacta bajo la caja: lo hecho hoy, lo que espera tu decisión (con
 * la edad de lo más viejo), los procesos con error y los compromisos vencidos.
 * Cada cifra lleva su línea de 14 días y su cambio sólo cuando de verdad hay
 * historia; las demás llevan una frase. Cada una abre su pantalla.
 */
export function OpsRow({ kpis }: { kpis: OpsKpi[] }) {
  if (kpis.length === 0) return null;
  return (
    <section aria-label="Lo que hace Cortex" className="flex flex-col gap-2">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
        Lo que hace Cortex
      </h2>
      <ul className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        {kpis.map((k) => (
          <li key={k.id} className="min-w-0">
            <Link
              href={k.href}
              className={clsx(
                'flex h-full flex-col gap-1.5 rounded-card border bg-surface p-3 transition-colors hover:border-border-strong focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary/40',
                k.alert ? 'border-rose/40' : 'border-border',
              )}
            >
              <span className="flex items-center gap-1.5 text-xs font-semibold text-ink-muted">
                {k.alert && <span aria-hidden className="h-1.5 w-1.5 rounded-pill bg-rose" />}
                <span className="truncate">{k.label}</span>
                {k.alert && <span className="sr-only">(pide atención)</span>}
              </span>
              <span className="stat-display text-2xl leading-tight tabular-nums text-ink">
                {k.value}
              </span>
              {k.spark.length >= 2 && (
                <Sparkline
                  values={k.spark}
                  labels={k.sparkLabels}
                  color={CHART_COLOR[k.alert ? 'rose' : k.id === 'hecho' ? 'emerald' : 'primary']}
                  height={28}
                  name={k.label}
                />
              )}
              <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-ink-faint">
                {k.ratio !== null && <DeltaPill ratio={k.ratio} good={k.good} compact />}
                <span>{k.hint}</span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
