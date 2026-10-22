import { FuentesStrip } from '@/components/finance/FuentesStrip';
import { Panel } from '@/components/ui/panel';
import { chipClass } from '@/lib/status-chip';
import type { SheetPayables } from '@cortex/agent-tools/src/accounting/sources/payables-read';
import { formatDay, formatMoney } from '@cortex/agent-tools/src/format/display';
import { FileSpreadsheet } from 'lucide-react';

/**
 * LO QUE DEBES SEGÚN TUS HOJAS (0239). Va encima de la bandeja de Por pagar
 * cuando hay hojas o tablas declaradas como fuente de compras y gastos: la
 * mezcla por origen, las diferencias con el libro, y las facturas abiertas que
 * sólo están en una hoja (no pasan por la revisión ni la aprobación: se pagan
 * por fuera). Sólo datos simples; sin hooks.
 */

const MAX = 8;

export function SheetPayablesPanel({ data }: { data: SheetPayables }) {
  const s = data.summary;
  return (
    <div className="mb-6 space-y-3">
      <FuentesStrip
        title="Por pagar sale de"
        items={data.items}
        differences={s.differences}
        differenceCount={s.differenceCount}
        issues={s.issues.map((i) => ({
          message: i.message,
          severity: i.severity,
          source: i.sourceLabel ?? null,
        }))}
        issueCount={s.issueCount}
        rejectedCount={s.rejectedCount}
        manageHref="/integrations"
      />
      {data.open.length > 0 ? (
        <Panel className="overflow-hidden">
          <div className="flex flex-wrap items-baseline justify-between gap-2 p-4 pb-2">
            <p className="flex items-center gap-1.5 text-sm font-bold text-ink">
              <FileSpreadsheet className="h-4 w-4 text-ink-faint" aria-hidden />
              Facturas abiertas que sólo están en una hoja
            </p>
            <p className="text-xs text-ink-muted">
              {formatMoney(data.openTotal, 'COP')}
              {data.overdueTotal > 0 ? `, vencido ${formatMoney(data.overdueTotal, 'COP')}` : ''}
            </p>
          </div>
          <ul className="divide-y divide-border border-t border-border">
            {data.open.slice(0, MAX).map((o) => (
              <li
                key={o.id}
                className="grid gap-x-4 gap-y-1 px-4 py-2.5 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_auto] sm:items-center"
              >
                <p className="min-w-0 text-xs">
                  <span className="tabular font-semibold text-ink">{o.number}</span>{' '}
                  <span className="text-ink-muted">· {o.supplier}</span>
                </p>
                <p className="flex flex-wrap items-center gap-1.5 text-micro text-ink-faint">
                  {o.dueOn ? (
                    <span
                      className={chipClass(
                        o.daysOverdue !== null && o.daysOverdue > 0 ? 'rose' : 'neutral',
                      )}
                    >
                      {o.daysOverdue !== null && o.daysOverdue > 0
                        ? `vencida hace ${o.daysOverdue} ${o.daysOverdue === 1 ? 'día' : 'días'}`
                        : `vence ${formatDay(o.dueOn)}`}
                    </span>
                  ) : (
                    <span className={chipClass('neutral')}>sin vencimiento</span>
                  )}
                  <span>{o.origin}</span>
                </p>
                <span className="tabular text-xs font-semibold text-ink">
                  {formatMoney(o.balance, o.currency)}
                </span>
              </li>
            ))}
          </ul>
          {data.open.length > MAX ? (
            <p className="border-t border-border p-3 text-center text-xs text-ink-muted">
              Y {data.open.length - MAX} más. Pídele a Cortex la lista completa.
            </p>
          ) : null}
        </Panel>
      ) : null}
    </div>
  );
}
