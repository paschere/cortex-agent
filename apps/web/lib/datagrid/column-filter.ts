import type { GridColumn, GridFilter } from '@/components/datagrid/types';
import { isNumericType } from './format';
import { isActiveFilter } from './view';

/**
 * EL FILTRO RÁPIDO DE UNA COLUMNA (el embudo del encabezado).
 *
 * Cada columna tiene a lo más UN filtro rápido, y es el mismo objeto que el
 * panel «Filtros» y las fichas de arriba («Estado: vencido ×») ya entienden:
 * opciones -> `in`, texto -> `contains`, número/fecha -> `between`, sí/no ->
 * `eq`. Así lo que se pone desde el encabezado se ve y se quita en un sólo
 * lugar.
 */

export interface QuickInput {
  list?: string[];
  text?: string;
  min?: string;
  max?: string;
  bool?: boolean | null;
}

export function isOptionColumn(column: GridColumn): boolean {
  return column.type === 'select' || column.type === 'status' || column.type === 'multi_select';
}

export function quickFilterFor(column: GridColumn, input: QuickInput): GridFilter | null {
  let f: GridFilter | null = null;
  if (isOptionColumn(column)) f = { key: column.key, op: 'in', value: input.list ?? [] };
  else if (column.type === 'boolean') {
    f =
      input.bool === null || input.bool === undefined
        ? null
        : { key: column.key, op: 'eq', value: input.bool };
  } else if (isNumericType(column.type) || column.type === 'date' || column.type === 'datetime') {
    f = { key: column.key, op: 'between', value: [input.min ?? '', input.max ?? ''] };
  } else f = { key: column.key, op: 'contains', value: (input.text ?? '').trim() };
  return f && isActiveFilter(f) ? f : null;
}

/** El filtro de esta columna (el primero), si hay. */
export function columnFilterOf(
  filters: readonly GridFilter[],
  key: string,
): GridFilter | undefined {
  return filters.find((f) => f.key === key);
}

/** Cambia (o quita, con `null`) el filtro rápido de la columna sin tocar los demás. */
export function replaceColumnFilter(
  filters: readonly GridFilter[],
  key: string,
  next: GridFilter | null,
): GridFilter[] {
  const at = filters.findIndex((f) => f.key === key);
  if (at < 0) return next ? [...filters, next] : [...filters];
  const out = [...filters];
  if (next) out[at] = next;
  else out.splice(at, 1);
  return out;
}

/** Lo que el formulario del embudo muestra, leído del filtro actual. */
export function quickInputOf(column: GridColumn, filter: GridFilter | undefined): QuickInput {
  if (!filter) return {};
  if (isOptionColumn(column))
    return { list: Array.isArray(filter.value) ? (filter.value as string[]) : [] };
  if (column.type === 'boolean')
    return { bool: typeof filter.value === 'boolean' ? filter.value : null };
  if (filter.op === 'between' && Array.isArray(filter.value))
    return { min: String(filter.value[0] ?? ''), max: String(filter.value[1] ?? '') };
  return { text: typeof filter.value === 'string' ? filter.value : '' };
}
