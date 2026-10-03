import type { ClientSalesSummary } from '@/lib/sales/types';
import { chipClass } from '@/lib/status-chip';
import { formatMoney } from '@cortex/agent-tools/src/sales/totals';
import { Plus, Receipt } from 'lucide-react';
import Link from 'next/link';

/**
 * «Cotizaciones y pedidos» en la ficha 360 del cliente (0182): lo último que
 * se le cotizó, pidió o facturó en Cortex, y el atajo a una cotización nueva
 * ya con el cliente puesto. Si la lectura falla, dice «sin dato».
 */
export function ClientSalesCard({
  clientId,
  summary,
}: {
  clientId: string;
  summary: ClientSalesSummary;
}) {
  return (
    <section className="rounded-card border border-border bg-surface shadow-card">
      <header className="flex items-center justify-between gap-2 px-5 pb-2 pt-4">
        <h2 className="flex items-center gap-2 text-sm font-bold text-ink">
          <Receipt className="h-4 w-4 text-ink-faint" aria-hidden />
          Cotizaciones y pedidos
        </h2>
        <Link
          href={`/ventas/nueva?cliente=${clientId}`}
          className="inline-flex items-center gap-1 rounded-pill px-2 py-1 text-xs font-semibold text-primary hover:bg-primary-soft"
        >
          <Plus className="h-3.5 w-3.5" aria-hidden />
          Cotizar
        </Link>
      </header>
      {summary.error ? (
        <p className="px-5 pb-4 text-sm text-ink-muted">
          <span className="font-semibold text-ink">Sin dato.</span> {summary.error}
        </p>
      ) : summary.docs.length === 0 ? (
        <p className="px-5 pb-4 text-sm text-ink-muted">
          Todavía no se le ha cotizado nada desde Cortex.
        </p>
      ) : (
        <>
          {summary.openQuotesTotal > 0 && (
            <p className="px-5 pb-1 text-xs text-ink-muted">
              {formatMoney(summary.openQuotesTotal)} en cotizaciones enviadas o aceptadas sin
              facturar.
            </p>
          )}
          <ul className="divide-y divide-border px-2 pb-2">
            {summary.docs.map((d) => (
              <li key={d.id}>
                <Link
                  href={`/ventas/${d.id}`}
                  className="flex items-center justify-between gap-3 rounded-sm px-3 py-2 text-sm hover:bg-surface-2"
                >
                  <span className="min-w-0">
                    <span className="font-semibold text-ink">{d.number}</span>
                    <span className="ml-2 text-xs text-ink-faint">{d.date}</span>
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    <span className="tabular-nums text-ink">
                      {formatMoney(d.total, d.currency)}
                    </span>
                    <span className={chipClass(d.statusTone)}>{d.statusLabel}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
