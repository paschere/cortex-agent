import type { GridColumn, GridRow } from '@/components/datagrid/types';
import { type XlsxColumn, type XlsxSheet, sheetName } from '@/lib/xlsx/write';
import {
  asBoolean,
  asList,
  dayKey,
  isEmptyValue,
  optionLabel,
  parseNumber,
  personName,
  toLocalInput,
} from './format';

/**
 * LA GRILLA, COMO HOJA DE EXCEL. Cada columna conserva su tipo: la plata sale
 * como número con formato de pesos, las fechas como fechas, las demás como
 * texto legible (las opciones con su nombre, no con su clave).
 */

function xlsxColumn(c: GridColumn): XlsxColumn {
  switch (c.type) {
    case 'money':
      return { header: c.label, type: 'money', currency: c.currency ?? 'COP' };
    case 'number':
      return { header: c.label, type: 'number' };
    case 'percent':
      return { header: c.label, type: 'percent' };
    case 'date':
      return { header: c.label, type: 'date' };
    case 'datetime':
      return { header: c.label, type: 'datetime' };
    case 'boolean':
      return { header: c.label, type: 'text' };
    default:
      return { header: c.label, type: 'text' };
  }
}

export function xlsxCellValue(column: GridColumn, value: unknown): unknown {
  if (isEmptyValue(value)) return null;
  switch (column.type) {
    case 'money':
    case 'number':
    case 'percent': {
      const n = parseNumber(value);
      return n === null ? String(value) : n;
    }
    case 'date':
      return dayKey(value) ?? String(value);
    case 'datetime':
      return toLocalInput(value) || String(value);
    case 'select':
    case 'status':
      return optionLabel(column, value);
    case 'multi_select':
      return asList(value)
        .map((v) => optionLabel(column, v))
        .join(', ');
    case 'boolean':
      return asBoolean(value) ? 'Sí' : 'No';
    case 'person':
      return personName(value);
    default:
      return typeof value === 'object' ? JSON.stringify(value) : String(value);
  }
}

export function gridToSheet(name: string, rows: GridRow[], columns: GridColumn[]): XlsxSheet {
  return {
    name: sheetName(name),
    columns: columns.map(xlsxColumn),
    rows: rows.map((row) => columns.map((c) => xlsxCellValue(c, row.values[c.key]))),
  };
}
