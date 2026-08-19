'use client';

import { usePanel } from '@/components/panel/PanelHost';
import { type ClientStatus, STATUS_TONE } from '@/lib/clients-shape';
import { type StatusTone, chipClass } from '@/lib/status-chip';
import { Building2 } from 'lucide-react';
import type { ResultViewProps } from './registry';

/**
 * EL DIRECTORIO, EN EL CHAT Y EN EL MARCO.
 *
 * Misma vista en los dos sitios: `clients.directory` pinta esto, y el panel
 * `clients` corre esa herramienta. Un clic abre la ficha al lado (`client` +
 * id). El navegador nombra la superficie, nunca la herramienta.
 */

interface Row {
  id: string;
  name: string;
  nit: string | null;
  status: string;
  statusLabel: string;
  city: string | null;
}

function statusTone(status: string): StatusTone {
  const tone = STATUS_TONE[status as ClientStatus];
  if (!tone) return 'neutral';
  return tone === 'sky' ? 'primary' : tone;
}

export function ClientsDirectory({ result }: ResultViewProps) {
  const { open, available } = usePanel();
  const view = directoryOf(result);
  if (!view) return null;

  if (view.clients.length === 0) {
    return (
      <p className="px-1 py-3 text-sm leading-relaxed text-ink-muted">
        Todavía no hay clientes en este espacio.
      </p>
    );
  }

  return (
    <div className="overflow-hidden rounded-card border border-border bg-surface shadow-card">
      <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <Building2 className="h-4 w-4 shrink-0 text-primary" aria-hidden />
        <span className="field-label">Clientes</span>
        <span className="tabular ml-auto text-micro text-ink-faint">{view.total}</span>
      </div>
      <ul className="divide-y divide-border">
        {view.clients.map((c) => (
          <li key={c.id}>
            <button
              type="button"
              disabled={!available}
              onClick={() => open('client', c.id)}
              className="flex w-full items-baseline gap-2 px-4 py-2.5 text-left transition-colors duration-150 hover:bg-surface-2 disabled:hover:bg-transparent motion-reduce:transition-none"
            >
              <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">{c.name}</span>
              {c.nit && <span className="tabular shrink-0 text-micro text-ink-faint">{c.nit}</span>}
              {c.city && (
                <span className="hidden shrink-0 text-micro text-ink-faint sm:inline">
                  {c.city}
                </span>
              )}
              <span className={chipClass(statusTone(c.status))}>{c.statusLabel}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function directoryOf(result: unknown): { clients: Row[]; total: number } | null {
  if (!result || typeof result !== 'object' || '__error' in result) return null;
  const r = result as Record<string, unknown>;
  if (!Array.isArray(r.clients)) return null;
  const clients = r.clients.flatMap((row): Row[] => {
    if (!row || typeof row !== 'object') return [];
    const v = row as Record<string, unknown>;
    if (typeof v.id !== 'string' || typeof v.name !== 'string') return [];
    return [
      {
        id: v.id,
        name: v.name,
        nit: typeof v.nit === 'string' ? v.nit : null,
        status: typeof v.status === 'string' ? v.status : '',
        statusLabel: typeof v.statusLabel === 'string' ? v.statusLabel : '',
        city: typeof v.city === 'string' ? v.city : null,
      },
    ];
  });
  return { clients, total: typeof r.total === 'number' ? r.total : clients.length };
}
