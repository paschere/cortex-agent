import type { GridAggregate, GridColumn, GridRow } from '@/components/datagrid/types';
import {
  formatMoney,
  formatNumber,
  formatPercent,
  isEmptyValue,
  isNumericType,
  parseNumber,
} from './format';

/**
 * LAS CIFRAS DEL PIE: suma, promedio, mínimo, máximo o cuántas tienen valor.
 *
 * Solo sobre columnas numéricas (número, plata, porcentaje), y sobre las filas
 * que la vista deja ver: el total de una lista filtrada es el total de lo que
 * se está mirando, que es la pregunta que alguien hace al bajar la vista.
 */

export const AGGREGATES: Array<{ kind: GridAggregate; label: string; short: string }> = [
  { kind: 'sum', label: 'Suma', short: 'Suma' },
  { kind: 'avg', label: 'Promedio', short: 'Prom.' },
  { kind: 'min', label: 'Mínimo', short: 'Mín.' },
  { kind: 'max', label: 'Máximo', short: 'Máx.' },
  { kind: 'count', label: 'Con valor', short: 'Con valor' },
  { kind: 'none', label: 'Nada', short: '' },
];

export function defaultAggregate(column: GridColumn): GridAggregate {
  if (!isNumericType(column.type)) return 'none';
  return column.type === 'percent' ? 'avg' : 'sum';
}

export function aggregateOf(
  column: GridColumn,
  aggregates: Record<string, GridAggregate> | undefined,
): GridAggregate {
  return aggregates?.[column.key] ?? defaultAggregate(column);
}

export function aggregate(rows: GridRow[], key: string, kind: GridAggregate): number | null {
  if (kind === 'none') return null;
  let count = 0;
  let sum = 0;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const row of rows) {
    const v = row.values[key];
    if (isEmptyValue(v)) continue;
    const n = parseNumber(v);
    if (n === null) continue;
    count += 1;
    sum += n;
    if (n < min) min = n;
    if (n > max) max = n;
  }
  if (kind === 'count') return count;
  if (!count) return null;
  if (kind === 'sum') return sum;
  if (kind === 'avg') return sum / count;
  if (kind === 'min') return min;
  if (kind === 'max') return max;
  return null;
}

export function formatAggregate(
  column: GridColumn,
  kind: GridAggregate,
  value: number | null,
): string {
  if (value === null) return '—';
  if (kind === 'count') return formatNumber(value, 0);
  if (column.type === 'money') return formatMoney(value, column.currency);
  if (column.type === 'percent') return formatPercent(value);
  return formatNumber(value);
}

/** Las sumas de un grupo, para la cabecera: solo plata y números. */
export function groupTotals(
  rows: GridRow[],
  columns: GridColumn[],
): Array<{ column: GridColumn; value: number }> {
  const out: Array<{ column: GridColumn; value: number }> = [];
  for (const column of columns) {
    if (column.type !== 'money' && column.type !== 'number') continue;
    const value = aggregate(rows, column.key, 'sum');
    if (value !== null) out.push({ column, value });
  }
  return out;
}
