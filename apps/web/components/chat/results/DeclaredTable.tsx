'use client';

import { clsx } from 'clsx';
import type { TableColumn, TableSpec } from './registry';

/**
 * LA CAPA DEL MEDIO: una tabla que alguien declaró, no que se adivinó.
 *
 * La diferencia con `StructuralResult` no es de aspecto, es de autoridad. La
 * capa estructural mira la forma y hace lo que puede; esto sabe qué columnas
 * importan, en qué orden y cómo se leen, porque alguien que conoce esa
 * herramienta lo escribió. Por eso sube a tarjeta y la otra no.
 *
 * Y por eso una entrada en `TABLE` son solo datos: quien conoce
 * `payments.receivables` no tiene que saber React para decir que la columna de
 * mora va después del importe y que el importe es dinero.
 */
export function DeclaredTable({ spec, result }: { spec: TableSpec; result: unknown }) {
  const rows = pickRows(result, spec.rows);
  const note = spec.note ? pickString(result, spec.note) : null;

  if (rows.length === 0) {
    return (
      <div className="rounded-card border border-border bg-surface px-4 py-3">
        <p className="text-[12.5px] text-ink-muted">{spec.empty}</p>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-card border border-border bg-surface">
      {note && (
        <p className="border-b border-border px-4 py-2.5 text-[12.5px] leading-relaxed text-ink-muted">
          {note}
        </p>
      )}
      {/* Su propio scroll: una tabla ancha no puede empujar la conversación. */}
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[12.5px]">
          <thead>
            <tr className="border-b border-border">
              {spec.columns.map((c) => (
                <th
                  key={c.key}
                  className={clsx(
                    'whitespace-nowrap px-4 py-2 text-[11px] font-semibold uppercase tracking-field text-ink-faint',
                    c.kind === 'number' || c.kind === 'money' ? 'text-right' : 'text-left',
                  )}
                >
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={rowKey(row, i)} className="border-b border-border/60 last:border-0">
                {spec.columns.map((c) => (
                  <td
                    key={c.key}
                    className={clsx(
                      'px-4 py-2 align-top text-ink',
                      (c.kind === 'number' || c.kind === 'money') && 'tabular-nums text-right',
                    )}
                  >
                    {render(dig(row, c.key), c)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** `a.b` baja un nivel. Nada más: una ruta de tres saltos es un dato mal puesto. */
function dig(row: Record<string, unknown>, key: string): unknown {
  if (!key.includes('.')) return row[key];
  const [head, tail] = key.split('.', 2);
  const nested = row[head ?? ''];
  return nested && typeof nested === 'object'
    ? (nested as Record<string, unknown>)[tail ?? '']
    : undefined;
}

function pickRows(result: unknown, key: string): Record<string, unknown>[] {
  if (!result || typeof result !== 'object') return [];
  const value = (result as Record<string, unknown>)[key];
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is Record<string, unknown> => !!v && typeof v === 'object');
}

function pickString(result: unknown, key: string): string | null {
  if (!result || typeof result !== 'object') return null;
  const value = (result as Record<string, unknown>)[key];
  return typeof value === 'string' && value.trim() ? value : null;
}

function rowKey(row: Record<string, unknown>, index: number): string {
  const id = row.id ?? row.slug ?? row.key;
  return typeof id === 'string' || typeof id === 'number' ? String(id) : `row-${index}`;
}

function render(value: unknown, column: TableColumn) {
  if (value === null || value === undefined || value === '') {
    return <span className="text-ink-faint">—</span>;
  }
  if (typeof value === 'boolean') return value ? 'Sí' : 'No';
  // Sin `Intl` ni formateo de moneda aquí a propósito: la herramienta ya
  // devuelve el número como quiere que se lea, con su moneda si la tiene, y
  // reformatearlo desde el navegador es cómo un total en dólares se convierte
  // en uno en pesos sin que nadie lo pida. `money` alinea; no convierte.
  return String(value);
}
