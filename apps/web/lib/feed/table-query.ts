import type { SheetData, SheetValue } from '@cortex/agent-tools/src/kb/spreadsheets';
import { z } from 'zod';

export const tableQuerySchema = z.object({
  attachmentId: z.string(),
  sheet: z.string().describe('Exact sheet name from the attachment'),
  operation: z.enum(['rows', 'sum', 'average', 'min', 'max', 'count']),
  column: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('One-based column index for numeric operations'),
  startRow: z
    .number()
    .int()
    .min(1)
    .default(2)
    .describe('First data row, one-based. Default skips the header'),
  filter: z
    .object({
      column: z.number().int().min(1),
      equals: z.union([z.string(), z.number(), z.boolean()]),
    })
    .optional(),
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(100).default(30),
});

export function querySheet(sheets: SheetData[], input: z.infer<typeof tableQuerySchema>) {
  const sheet = sheets.find((s) => s.name === input.sheet);
  if (!sheet) throw new Error('No existe esa hoja.');
  const width = Math.max(0, ...sheet.rows.map((r) => r.length));
  for (const column of [input.column, input.filter?.column]) {
    if (column !== undefined && column > width) throw new Error('No existe esa columna.');
  }
  const rows = sheet.rows
    .slice(input.startRow - 1)
    .map((values, i) => ({ row: i + input.startRow, values }))
    .filter(
      ({ values }) => !input.filter || values[input.filter.column - 1] === input.filter.equals,
    );
  const source = {
    sheet: sheet.name,
    matchedRows: rows.length,
    startRow: input.startRow,
    filter: input.filter ?? null,
    ...repeatedRows(rows),
  };
  if (input.operation === 'rows')
    return {
      ...source,
      rows: rows.slice(input.offset, input.offset + input.limit),
      hasMore: rows.length > input.offset + input.limit,
    };
  if (input.operation === 'count') return { ...source, value: rows.length };
  if (input.column === undefined) throw new Error('Indica la columna para calcular.');
  const values: SheetValue[] = rows.map(
    ({ values }) => values[(input.column as number) - 1] ?? null,
  );
  const numbers = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  // Strings may be locale-specific amounts or identifiers. Silently skipping
  // them would make a partial sum look like the total for the selected rows.
  if (
    values.some((v) => v !== null && v !== '' && (typeof v !== 'number' || !Number.isFinite(v)))
  ) {
    throw new Error(
      'La columna contiene valores no numéricos. Revisa las filas y el formato antes de calcular.',
    );
  }
  if (!numbers.length) throw new Error('No hay valores numéricos en las filas seleccionadas.');
  const sum = numbers.reduce((a, b) => a + b, 0);
  const value =
    input.operation === 'sum'
      ? sum
      : input.operation === 'average'
        ? sum / numbers.length
        : input.operation === 'min'
          ? Math.min(...numbers)
          : Math.max(...numbers);
  if (!Number.isFinite(value)) throw new Error('El resultado supera el rango numérico admitido.');
  return {
    ...source,
    column: input.column,
    numericCells: numbers.length,
    blankCells: values.length - numbers.length,
    value,
  };
}

function repeatedRows(rows: Array<{ row: number; values: SheetValue[] }>) {
  const seen = new Set<string>();
  const duplicateRows: number[] = [];
  for (const row of rows) {
    if (row.values.every((v) => v === null || v === '')) continue;
    const key = JSON.stringify(row.values);
    if (seen.has(key)) duplicateRows.push(row.row);
    else seen.add(key);
  }
  return {
    duplicateRowCount: duplicateRows.length,
    duplicateRowExamples: duplicateRows.slice(0, 10),
    requiresDuplicateReview: duplicateRows.length > 0,
    ...(duplicateRows.length
      ? {
          warning:
            'Hay filas idénticas. El cálculo incluye todas las filas; confirma si son repeticiones o eventos distintos antes de usarlo como cifra de negocio. No se eliminó ninguna.',
        }
      : {}),
  };
}
