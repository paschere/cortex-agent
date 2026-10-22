import { Panel } from '@/components/ui/panel';
import { CHIP_INTERACTIVE, chipClass } from '@/lib/status-chip';
import { formatMoney } from '@cortex/agent-tools/src/format/display';
import clsx from 'clsx';
import { AlertTriangle, Layers } from 'lucide-react';
import Link from 'next/link';

/**
 * «DE DÓNDE SALEN ESTAS CIFRAS» (fuentes contables combinadas, 0239).
 *
 * Una línea bajo el título de Cartera, Por pagar y Hoy: cada origen con lo que
 * aporta («Siigo $31.000.000 · Hoja: Ventas Medellín $17.000.000»), y debajo,
 * plegado, las facturas que valen distinto entre el programa y la hoja y las
 * filas que no entraron por datos sucios. Sin hooks: sirve igual en un
 * componente de servidor (sólo con datos simples) o de cliente (con `onSelect`
 * para filtrar por origen; una función nunca cruza de servidor a cliente).
 */

export interface FuenteItem {
  origin: string;
  amount: number;
  count: number;
}

export interface FuentesStripProps {
  /** «Por cobrar sale de», «Por pagar sale de». */
  title: string;
  items: FuenteItem[];
  currency?: string;
  differences?: Array<{ message: string }>;
  differenceCount?: number;
  issues?: Array<{ message: string; severity: 'rechazada' | 'aviso'; source: string | null }>;
  issueCount?: number;
  rejectedCount?: number;
  /** Dónde se configuran (Integraciones). */
  manageHref?: string;
  /** Sólo desde un componente de cliente: filtrar por un origen (o quitar el filtro con null). */
  onSelect?: (origin: string | null) => void;
  active?: string | null;
  className?: string;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function FuentesStrip({
  title,
  items,
  currency = 'COP',
  differences = [],
  differenceCount = differences.length,
  issues = [],
  issueCount = issues.length,
  rejectedCount = 0,
  manageHref,
  onSelect,
  active = null,
  className,
}: FuentesStripProps) {
  if (items.length === 0 && differenceCount === 0 && issueCount === 0) return null;
  return (
    <Panel className={clsx('p-4', className)}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <p className="flex items-center gap-1.5 text-xs font-bold text-ink">
          <Layers className="h-3.5 w-3.5 text-ink-faint" aria-hidden />
          {title}
        </p>
        <ul className="flex flex-wrap items-center gap-1.5">
          {items.map((i) => {
            const label = `${i.origin} · ${formatMoney(i.amount, currency)} · ${plural(i.count, 'factura')}`;
            const isActive = active === i.origin;
            return (
              <li key={i.origin}>
                {onSelect ? (
                  <button
                    type="button"
                    onClick={() => onSelect(isActive ? null : i.origin)}
                    aria-pressed={isActive}
                    className={clsx(
                      chipClass(isActive ? 'primary' : 'neutral'),
                      CHIP_INTERACTIVE,
                      'min-h-9 cursor-pointer',
                    )}
                  >
                    {label}
                  </button>
                ) : (
                  <span className={chipClass('neutral')}>{label}</span>
                )}
              </li>
            );
          })}
        </ul>
        {manageHref ? (
          <Link
            href={manageHref}
            className="ml-auto inline-flex min-h-9 items-center text-xs font-semibold text-primary hover:underline"
          >
            Fuentes contables
          </Link>
        ) : null}
      </div>

      {differenceCount > 0 ? (
        <details className="mt-3 rounded-sm bg-amber-soft px-3 py-2 text-xs text-amber">
          <summary className="flex min-h-9 cursor-pointer list-none items-center gap-1.5 font-semibold [&::-webkit-details-marker]:hidden">
            <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
            {differenceCount === 1
              ? '1 factura vale distinto'
              : `${differenceCount} facturas valen distinto`}{' '}
            entre el programa contable y una hoja
          </summary>
          <ul className="mt-1.5 space-y-1 pb-1 text-ink">
            {differences.map((d) => (
              <li key={d.message}>{d.message}</li>
            ))}
            {differenceCount > differences.length ? (
              <li className="text-ink-muted">
                … y {differenceCount - differences.length} más (pídele a Cortex las fuentes
                contables).
              </li>
            ) : null}
          </ul>
          <p className="pb-1 text-ink-muted">
            No se suman dos veces: entra el valor de la fuente que manda.
          </p>
        </details>
      ) : null}

      {issueCount > 0 ? (
        <details className="mt-2 rounded-sm bg-surface-2 px-3 py-2 text-xs text-ink-muted">
          <summary className="flex min-h-9 cursor-pointer list-none items-center gap-1.5 font-semibold text-ink [&::-webkit-details-marker]:hidden">
            {rejectedCount > 0
              ? `${plural(rejectedCount, 'fila')} de las hojas no ${rejectedCount === 1 ? 'entró' : 'entraron'} por datos incompletos`
              : `${plural(issueCount, 'aviso')} sobre los datos de las hojas`}
          </summary>
          <ul className="mt-1.5 space-y-1 pb-1">
            {issues.map((i) => (
              <li key={`${i.source}-${i.message}`}>
                {i.source ? <span className="font-semibold text-ink">{i.source}: </span> : null}
                {i.message}
              </li>
            ))}
            {issueCount > issues.length ? <li>… y {issueCount - issues.length} más.</li> : null}
          </ul>
        </details>
      ) : null}
    </Panel>
  );
}
