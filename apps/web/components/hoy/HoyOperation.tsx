import { Sparkline } from '@/components/charts/Sparkline';
import { CHART_COLOR } from '@/components/charts/colors';
import type { OperationView } from '@/lib/hoy/insights';
import { clsx } from 'clsx';
import Link from 'next/link';
import { SectionHead } from './SectionHead';

/**
 * «LA OPERACIÓN DE HOY»: lo que pasa en la carga, leído de las tablas de la
 * operación (vuelos y prealertas). Cuántos vuelos esperas, cuántos ya
 * aterrizaron y cuáles quedaron abiertos con fecha pasada (para cerrarlos o
 * corregirlos); y el ritmo de prealertas de los últimos 14 días. Cada cifra
 * abre su tabla. Sin tablas de operación el bloque no sale.
 */
export function HoyOperation({ op }: { op: OperationView }) {
  const f = op.flights;
  const p = op.prealerts;
  return (
    <section aria-label="La operación de hoy" className="flex flex-col gap-3">
      <SectionHead
        title="La operación de hoy"
        hint="Vuelos y prealertas, de las tablas de la operación"
        href={f?.href ?? p?.href}
        hrefLabel="Abrir la tabla"
      />
      <div className="grid gap-2 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        {f && (
          <div className="flex min-w-0 flex-col gap-3 rounded-card border border-border bg-surface p-3">
            <ul className="grid grid-cols-2 gap-x-3 gap-y-3 sm:grid-cols-4">
              <Stat
                label="Esperas"
                value={f.upcoming}
                hint={f.upcoming === 1 ? 'vuelo por llegar' : 'vuelos por llegar'}
                href={f.href}
              />
              <Stat
                label="Aterrizaron hoy"
                value={f.landedToday}
                hint={`${f.landedWeek} en 7 días`}
                href={f.href}
              />
              <Stat
                label="Demorados"
                value={f.delayed}
                hint={f.delayed === 0 ? 'ninguno' : 'revisa la hora'}
                alert={f.delayed > 0}
                href={f.href}
              />
              <Stat
                label="Sin cerrar"
                value={f.stale}
                hint={f.stale === 0 ? 'todo al día' : 'fecha pasada, sin aterrizar'}
                alert={f.stale > 0}
                href={f.href}
              />
            </ul>
            {f.next.length > 0 ? (
              <ul
                className="flex flex-col divide-y divide-border border-t border-border"
                aria-label="Próximos vuelos"
              >
                {f.next.map((v) => (
                  <li
                    key={`${v.label}-${v.when}`}
                    className="flex items-baseline justify-between gap-3 py-2 text-xs"
                  >
                    <span className="min-w-0 truncate">
                      <span className="font-semibold text-ink">{v.label}</span>
                      {v.airline && <span className="text-ink-faint"> · {v.airline}</span>}
                    </span>
                    <span className="flex shrink-0 items-baseline gap-2">
                      <span
                        className={clsx('text-ink-muted', v.late && 'font-semibold text-amber')}
                      >
                        {v.status}
                      </span>
                      <span className="tabular tabular-nums text-ink-faint">{v.when}</span>
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="border-t border-border pt-2 text-xs text-ink-faint">
                No hay vuelos programados por llegar.
              </p>
            )}
          </div>
        )}
        {p && (
          <Link
            href={p.href}
            className="flex min-w-0 flex-col gap-1.5 rounded-card border border-border bg-surface p-3 transition-colors hover:border-border-strong focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary/40"
          >
            <span className="text-xs font-semibold text-ink-muted">Prealertas</span>
            <span className="stat-display text-xl leading-tight tabular-nums text-ink">
              {p.today}
              <span className="ml-2 font-sans text-xs text-ink-faint">hoy</span>
            </span>
            <Sparkline
              values={p.spark}
              labels={p.sparkLabels}
              color={CHART_COLOR.sky}
              fmt="count"
              height={40}
              name="Prealertas por día"
              showLabels
            />
            <span className="text-micro text-ink-faint">
              {p.week} en 7 días
              {p.today === 0 && p.last ? ` · la última llegó ${p.last}` : ''}
            </span>
          </Link>
        )}
      </div>
    </section>
  );
}

function Stat({
  label,
  value,
  hint,
  alert,
  href,
}: {
  label: string;
  value: number;
  hint: string;
  alert?: boolean;
  href: string;
}) {
  return (
    <li className="min-w-0">
      <Link
        href={href}
        className="flex flex-col gap-0.5 rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary/40"
      >
        <span className="flex items-center gap-1.5 text-xs font-semibold text-ink-muted">
          {alert && <span aria-hidden className="h-1.5 w-1.5 rounded-pill bg-amber" />}
          <span className="truncate">{label}</span>
          {alert && <span className="sr-only">(pide atención)</span>}
        </span>
        <span className="stat-display text-xl leading-tight tabular-nums text-ink">{value}</span>
        <span className="text-micro text-ink-faint">{hint}</span>
      </Link>
    </li>
  );
}
