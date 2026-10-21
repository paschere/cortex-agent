import type { DianView } from '@/lib/hoy/insights';
import { formatDay, formatMoney } from '@cortex/agent-tools/src/format/display';
import { ExternalLink } from 'lucide-react';
import { SectionHead } from './SectionHead';

/**
 * «FACTURAS CON LA DIAN»: sólo sale cuando hay algo que corregir (rechazadas o
 * sin respuesta). Cada fila dice cuál factura, de quién, de cuánto y qué contestó
 * la DIAN, y abre la factura en Siigo. Cuando todo está aceptado lo dice la
 * tarjeta de «Esta semana» y este bloque no ocupa lugar.
 */
export function DianPanel({ dian }: { dian: DianView }) {
  if (dian.problems.length === 0) return null;
  return (
    <section aria-label="Facturas con la DIAN" className="flex flex-col gap-2">
      <SectionHead
        title="Facturas por corregir con la DIAN"
        hint={`${dian.rejected} rechazadas · ${dian.pending} sin respuesta · ${dian.accepted} aceptadas`}
        href={dian.href}
        hrefLabel="Ver todas"
      />
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">Facturas rechazadas o sin respuesta de la DIAN</caption>
          <thead>
            <tr className="text-left text-xs text-ink-faint">
              <th scope="col" className="py-2 pr-3 font-semibold">
                Factura
              </th>
              <th scope="col" className="hidden py-2 pr-3 font-semibold sm:table-cell">
                Cliente
              </th>
              <th scope="col" className="py-2 pr-3 text-right font-semibold">
                Total
              </th>
              <th scope="col" className="py-2 text-right font-semibold">
                Estado
              </th>
            </tr>
          </thead>
          <tbody>
            {dian.problems.map((p) => (
              <tr key={p.number} className="border-t border-border align-top">
                <td className="py-3 pr-3">
                  <span className="flex items-center gap-1.5 font-semibold text-ink">
                    {p.number}
                    {p.url && (
                      <a
                        href={p.url}
                        target="_blank"
                        rel="noreferrer"
                        aria-label={`Abrir la factura ${p.number} en Siigo`}
                        className="text-ink-faint hover:text-ink"
                      >
                        <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                      </a>
                    )}
                  </span>
                  <span className="block text-micro text-ink-faint sm:hidden">{p.client}</span>
                  {p.message && (
                    <span className="block text-micro text-ink-faint">{p.message}</span>
                  )}
                </td>
                <td className="hidden py-3 pr-3 text-ink-muted sm:table-cell">{p.client}</td>
                <td className="tabular whitespace-nowrap py-3 pr-3 text-right font-semibold tabular-nums text-ink">
                  {formatMoney(p.amount, dian.currency)}
                </td>
                <td className="py-3 text-right">
                  <span
                    className={
                      p.state === 'rejected'
                        ? 'whitespace-nowrap rounded-pill bg-rose-soft px-2.5 py-0.5 text-xs font-semibold text-rose'
                        : 'whitespace-nowrap rounded-pill bg-amber-soft px-2.5 py-0.5 text-xs font-semibold text-amber'
                    }
                  >
                    {p.state === 'rejected' ? 'Rechazada' : 'Sin respuesta'}
                  </span>
                  <span className="block text-micro text-ink-faint">
                    {p.date ? formatDay(p.date) : ''}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
