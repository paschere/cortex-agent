import type { ClientOpportunityView } from '@/lib/crm/shape';
import { chipClass } from '@/lib/status-chip';
import { Handshake, Plus } from 'lucide-react';
import Link from 'next/link';

/**
 * «Oportunidades» en la ficha 360 del cliente (0193): los negocios abiertos y
 * los últimos cerrados, con su etapa, valor y siguiente paso, y el atajo al
 * embudo. Si la lectura falla, dice «sin dato».
 */
export function ClientOpportunitiesCard({
  items,
  error,
  riskLabel,
}: {
  items: ClientOpportunityView[];
  error: string | null;
  /** «Riesgo alto de perderse», si la última lectura lo dijo. */
  riskLabel?: string | null;
}) {
  return (
    <section className="rounded-card border border-border bg-surface shadow-card">
      <header className="flex items-center justify-between gap-2 px-5 pb-2 pt-4">
        <h2 className="flex items-center gap-2 text-sm font-bold text-ink">
          <Handshake className="h-4 w-4 text-ink-faint" aria-hidden />
          Oportunidades
        </h2>
        <Link
          href="/comercial?tab=oportunidades"
          className="inline-flex items-center gap-1 rounded-pill px-2 py-1 text-xs font-semibold text-primary hover:bg-primary-soft"
        >
          <Plus className="h-3.5 w-3.5" aria-hidden />
          Negocio
        </Link>
      </header>
      {riskLabel && (
        <p className="mx-5 mb-2 rounded-sm bg-rose-soft px-3 py-1.5 text-xs font-semibold text-rose">
          {riskLabel} ·{' '}
          <Link href="/comercial?tab=riesgo" className="underline underline-offset-2">
            ver por qué
          </Link>
        </p>
      )}
      {error ? (
        <p className="px-5 pb-4 text-sm text-ink-muted">
          <span className="font-semibold text-ink">Sin dato.</span> {error}
        </p>
      ) : items.length === 0 ? (
        <p className="px-5 pb-4 text-sm text-ink-muted">Ningún negocio abierto con este cliente.</p>
      ) : (
        <ul className="divide-y divide-border px-2 pb-2">
          {items.map((o) => (
            <li key={o.id}>
              <Link
                href={o.href}
                className="flex items-start justify-between gap-3 rounded-sm px-3 py-2 text-sm hover:bg-surface-2"
              >
                <span className="min-w-0">
                  <span className="block truncate font-semibold text-ink">{o.title}</span>
                  <span className="block truncate text-xs text-ink-faint">
                    {o.closeLabel ?? 'Sin fecha de cierre'}
                    {o.nextStep ? ` · ${o.nextStep}` : ''}
                  </span>
                </span>
                <span className="flex shrink-0 flex-col items-end gap-1">
                  <span className="tabular-nums text-ink">{o.valueLabel}</span>
                  <span className={chipClass(o.tone)}>{o.stageLabel}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
