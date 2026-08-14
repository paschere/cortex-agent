'use client';

import { ResultGrid } from './ResultGrid';
import type { TableSpec } from './registry';

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
 *
 * LO QUE YA NO ESTÁ AQUÍ: cómo se pinta una tabla. Eso era una copia de la que
 * tenía `StructuralResult`, con el relleno distinto, la alineación distinta y
 * sin el aviso de corte, y ahora es `ResultGrid` — el mismo componente para las
 * dos capas. Lo único que sigue siendo de este archivo es lo que de verdad
 * distingue a la capa declarada: sacar las filas del sitio que dice la
 * especificación, y decir algo cuando no hay ninguna.
 */
export function DeclaredTable({ spec, result }: { spec: TableSpec; result: unknown }) {
  const rows = pickRows(result, spec.rows);
  const note = spec.note ? pickString(result, spec.note) : null;

  if (rows.length === 0) {
    return (
      <div className="rounded-card border border-border bg-surface px-4 py-3">
        <p className="text-xs text-ink-muted">{spec.empty}</p>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-card border border-border bg-surface">
      {note && (
        <p className="border-b border-border px-4 py-2.5 text-xs leading-relaxed text-ink-muted">
          {note}
        </p>
      )}
      <ResultGrid columns={spec.columns} rows={rows} density="card" />
    </div>
  );
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
