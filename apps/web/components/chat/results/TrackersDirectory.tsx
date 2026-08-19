'use client';

import { usePanel } from '@/components/panel/PanelHost';
import { Table2 } from 'lucide-react';
import { PinSurface } from '../PinSurface';
import type { ResultViewProps } from './registry';

/**
 * Las tablas que este espacio se inventó, en el chat y en el marco.
 *
 * Un clic abre esa tabla al lado (`tracker` + slug). El navegador nombra la
 * superficie, nunca la herramienta.
 */

interface Row {
  slug: string;
  name: string;
  description: string;
  rowCount: number;
}

export function TrackersDirectory({ result, toolCallId }: ResultViewProps) {
  const { open, available } = usePanel();
  const view = directoryOf(result);
  if (!view) return null;

  if (view.trackers.length === 0) {
    return (
      <p className="px-1 py-3 text-sm leading-relaxed text-ink-muted">
        Todavía no hay tablas inventadas en este espacio. Dime qué hay que vigilar —remates,
        contenedores, un listado que no cabe en clientes ni en cartera— y la armo.
      </p>
    );
  }

  return (
    <div className="overflow-hidden rounded-card border border-border bg-surface shadow-card">
      <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <Table2 className="h-4 w-4 shrink-0 text-primary" aria-hidden />
        <span className="field-label">Tablas</span>
        <span className="ml-auto flex items-center gap-2">
          <span className="tabular text-micro text-ink-faint">{view.total}</span>
          <PinSurface surface="trackers" hidden={toolCallId.startsWith('panel:')} />
        </span>
      </div>
      <ul className="divide-y divide-border">
        {view.trackers.map((t) => (
          <li key={t.slug}>
            <button
              type="button"
              disabled={!available}
              onClick={() => open('tracker', t.slug)}
              className="flex w-full items-baseline gap-2 px-4 py-2.5 text-left transition-colors duration-150 hover:bg-surface-2 disabled:hover:bg-transparent motion-reduce:transition-none"
            >
              <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">{t.name}</span>
              <span className="tabular shrink-0 text-micro text-ink-faint">
                {t.rowCount === 1 ? '1 fila' : `${t.rowCount} filas`}
              </span>
            </button>
            {t.description ? (
              <p className="-mt-1 px-4 pb-2.5 text-micro text-ink-faint">{t.description}</p>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function directoryOf(result: unknown): { trackers: Row[]; total: number } | null {
  if (!result || typeof result !== 'object' || '__error' in result) return null;
  const r = result as Record<string, unknown>;
  if (!Array.isArray(r.trackers)) return null;
  const trackers = r.trackers.flatMap((row): Row[] => {
    if (!row || typeof row !== 'object') return [];
    const v = row as Record<string, unknown>;
    if (typeof v.slug !== 'string' || typeof v.name !== 'string') return [];
    return [
      {
        slug: v.slug,
        name: v.name,
        description: typeof v.description === 'string' ? v.description : '',
        rowCount: typeof v.rowCount === 'number' ? v.rowCount : 0,
      },
    ];
  });
  return { trackers, total: typeof r.total === 'number' ? r.total : trackers.length };
}
