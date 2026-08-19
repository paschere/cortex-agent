'use client';

import { Table2 } from 'lucide-react';
import { PinSurface } from '../PinSurface';
import type { ResultViewProps } from './registry';

/**
 * Una tabla inventada, pintada con las columnas que el agente definió.
 *
 * Como máximo seis columnas visibles: una tabla que no cabe en el chat no es
 * una tabla, es un JSON con rayas. El resto de campos sigue en `values` y el
 * modelo los tiene en el markdown.
 */

interface Field {
  key: string;
  label: string;
  type: string;
}

interface Entry {
  id: string;
  label: string;
  values: Record<string, string | number>;
}

interface View {
  slug: string;
  name: string;
  fields: Field[];
  rows: Entry[];
  total: number;
}

const OPEN_COLS = 5;

export function TrackerTable({ result, toolCallId }: ResultViewProps) {
  const view = tableOf(result);
  if (!view) return null;

  const columns = view.fields.slice(0, OPEN_COLS);

  return (
    <div className="overflow-hidden rounded-card border border-border bg-surface shadow-card">
      <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <Table2 className="h-4 w-4 shrink-0 text-primary" aria-hidden />
        <span className="field-label">{view.name}</span>
        <span className="ml-auto flex items-center gap-2">
          <span className="tabular text-micro text-ink-faint">
            {view.total === 1 ? '1 fila' : `${view.total} filas`}
          </span>
          <PinSurface
            surface="tracker"
            surfaceKey={view.slug}
            hidden={toolCallId.startsWith('panel:')}
          />
        </span>
      </div>

      {view.rows.length === 0 ? (
        <p className="px-4 py-4 text-sm leading-relaxed text-ink-muted">
          Esta tabla todavía no tiene filas. Dime qué anotar.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-border text-micro font-semibold uppercase tracking-field text-ink-faint">
                {columns.map((col) => (
                  <th key={col.key} className="px-4 py-2 font-semibold">
                    {col.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {view.rows.map((row) => (
                <tr key={row.id}>
                  {columns.map((col, i) => {
                    const value = row.values[col.key];
                    const shown = value === undefined || value === '' ? '—' : String(value);
                    return (
                      <td
                        key={col.key}
                        className={
                          i === 0 ? 'px-4 py-2 font-medium text-ink' : 'px-4 py-2 text-ink-muted'
                        }
                      >
                        {shown}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function tableOf(result: unknown): View | null {
  if (!result || typeof result !== 'object' || '__error' in result) return null;
  const r = result as Record<string, unknown>;
  const raw = r.tracker;
  if (!raw || typeof raw !== 'object') return null;
  const tracker = raw as Record<string, unknown>;
  if (typeof tracker.slug !== 'string' || typeof tracker.name !== 'string') return null;
  if (!Array.isArray(tracker.fields) || !Array.isArray(r.rows)) return null;

  const fields = tracker.fields.flatMap((row): Field[] => {
    if (!row || typeof row !== 'object') return [];
    const f = row as Record<string, unknown>;
    if (typeof f.key !== 'string' || typeof f.label !== 'string') return [];
    return [{ key: f.key, label: f.label, type: typeof f.type === 'string' ? f.type : 'text' }];
  });

  const rows = r.rows.flatMap((row): Entry[] => {
    if (!row || typeof row !== 'object') return [];
    const e = row as Record<string, unknown>;
    if (typeof e.id !== 'string' || typeof e.label !== 'string') return [];
    const values =
      e.values && typeof e.values === 'object' && !Array.isArray(e.values)
        ? (e.values as Record<string, string | number>)
        : {};
    return [{ id: e.id, label: e.label, values }];
  });

  return {
    slug: tracker.slug,
    name: tracker.name,
    fields,
    rows,
    total: typeof r.total === 'number' ? r.total : rows.length,
  };
}
