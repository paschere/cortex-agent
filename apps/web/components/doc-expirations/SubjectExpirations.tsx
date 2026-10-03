import { Panel, PanelHead } from '@/components/ui/panel';
import { chipClass } from '@/lib/status-chip';
import { CalendarClock } from 'lucide-react';
import Link from 'next/link';

/**
 * «Documentos que vencen» de UN sujeto (un cliente, un vehículo): el panel
 * que se cuelga en la ficha 360 del cliente. Presentacional, sin estado: la
 * página lee y le pasa las filas ya dichas en palabras.
 */

export interface SubjectExpirationItem {
  id: string;
  title: string;
  kindLabel: string;
  expiresOn: string | null;
  when: string;
  status: string;
  statusLabel: string;
  needsReview: boolean;
}

const TONE: Record<string, 'emerald' | 'amber' | 'rose' | 'neutral'> = {
  vigente: 'emerald',
  por_vencer: 'amber',
  vencido: 'rose',
  renovado: 'neutral',
};

export function SubjectExpirations({
  items,
  href,
  error,
}: {
  items: SubjectExpirationItem[];
  /** La lista completa, filtrada por este sujeto. */
  href: string;
  error?: string | null;
}) {
  return (
    <Panel>
      <PanelHead
        icon={<CalendarClock className="h-4 w-4" aria-hidden />}
        title="Documentos que vencen"
        right={items.length ? String(items.length) : undefined}
      />
      {error ? (
        <p className="px-6 pb-5 pt-3 text-sm text-ink-muted">Sin dato. {error}</p>
      ) : items.length === 0 ? (
        <p className="px-6 pb-5 pt-3 text-sm text-ink-muted">
          Ningún contrato ni póliza con fecha a su nombre.{' '}
          <Link href="/documentos-vencen" className="font-semibold text-primary hover:underline">
            Registrar uno
          </Link>
        </p>
      ) : (
        <ul className="mt-2 divide-y divide-border pb-2">
          {items.slice(0, 6).map((e) => (
            <li key={e.id} className="flex items-baseline justify-between gap-3 px-6 py-2.5">
              <div className="min-w-0">
                <p className="truncate text-sm text-ink">{e.title}</p>
                <p className="text-xs text-ink-faint">
                  {e.kindLabel}
                  {e.expiresOn ? ` · ${e.when}` : ''}
                </p>
              </div>
              <span className={chipClass(e.needsReview ? 'amber' : (TONE[e.status] ?? 'neutral'))}>
                {e.needsReview ? 'Por revisar' : e.statusLabel}
              </span>
            </li>
          ))}
          <li className="px-6 py-2 text-xs">
            <Link href={href} className="font-semibold text-primary hover:underline">
              Ver todos{items.length > 6 ? ` (${items.length})` : ''}
            </Link>
          </li>
        </ul>
      )}
    </Panel>
  );
}
