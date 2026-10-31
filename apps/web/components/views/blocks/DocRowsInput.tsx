'use client';

import { normalizeDocRows } from '@cortex/agent-tools/src/views/form-doc-rows';
import { clsx } from 'clsx';
import { Plus, X } from 'lucide-react';
import type { ScanResponse } from './form-data-source';

/**
 * Los renglones que Cortex leyó del documento (las guías de un manifiesto): se revisan y
 * se corrigen aquí antes de enviar. Se guardan como filas de la tabla hija al enviar.
 */

export interface DocRowsState {
  title: string;
  keyField: string;
  fields: NonNullable<ScanResponse['rowFields']>;
  rows: Array<Record<string, string>>;
}

/** Otra página del mismo documento: suma sus renglones sin repetir los que ya están. */
export function mergeDocRows(old: DocRowsState | null, body: ScanResponse): DocRowsState | null {
  if (!body.rowFields?.length || !body.rowsKey) return old;
  const fields = body.rowFields;
  const keyField = body.rowsKey;
  return {
    title: body.rowsTitle ?? 'Filas del documento',
    keyField,
    fields,
    rows: normalizeDocRows([...(old?.rows ?? []), ...(body.rows ?? [])], {
      key: keyField,
      fields: fields.map((f) => f.key),
    }),
  };
}

export function DocRowsInput({
  state,
  onChange,
  large,
}: {
  state: DocRowsState;
  onChange: (next: DocRowsState | null) => void;
  large?: boolean;
}) {
  const setRows = (rows: DocRowsState['rows']) => onChange({ ...state, rows });
  const input = clsx(
    'w-full min-w-0 rounded-sm border border-border-strong bg-surface px-2 text-ink',
    large ? 'h-12 text-base' : 'h-10 text-sm',
  );
  return (
    <section className="sm:col-span-2" aria-label={state.title}>
      <p className={clsx('mb-2 font-semibold text-ink', large ? 'text-base' : 'text-sm')}>
        {state.title} ({state.rows.length})
      </p>
      <ul className="space-y-2">
        {state.rows.map((row, i) => (
          <li
            key={`${i}-${row[state.keyField] ?? ''}`}
            className="rounded-sm border border-border bg-surface-2 p-2"
          >
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {state.fields.map((f) => (
                <label key={f.key} className="min-w-0 text-micro font-medium text-ink-faint">
                  {f.label}
                  {f.options?.length ? (
                    <select
                      className={input}
                      value={row[f.key] ?? ''}
                      onChange={(e) =>
                        setRows(state.rows.map((r, j) => (j === i ? { ...r, [f.key]: e.target.value } : r)))
                      }
                    >
                      <option value="" />
                      {f.options.map((o) => (
                        <option key={o} value={o}>
                          {o}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      className={input}
                      inputMode={f.type === 'number' || f.type === 'money' ? 'decimal' : undefined}
                      defaultValue={row[f.key] ?? ''}
                      onBlur={(e) =>
                        setRows(state.rows.map((r, j) => (j === i ? { ...r, [f.key]: e.target.value } : r)))
                      }
                    />
                  )}
                </label>
              ))}
            </div>
            <button
              type="button"
              onClick={() => setRows(state.rows.filter((_, j) => j !== i))}
              className="mt-2 inline-flex min-h-10 items-center gap-1 text-xs font-semibold text-ink-faint hover:text-ink"
            >
              <X className="h-3.5 w-3.5" aria-hidden />
              Quitar
            </button>
          </li>
        ))}
      </ul>
      <button
        type="button"
        onClick={() => setRows([...state.rows, {}])}
        className="mt-2 inline-flex min-h-10 items-center gap-1 text-xs font-semibold text-primary-ink"
      >
        <Plus className="h-3.5 w-3.5" aria-hidden />
        Agregar otra
      </button>
    </section>
  );
}
