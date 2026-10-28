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
  endRow: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('Last row to consider, one-based and inclusive (row range with startRow)'),
  filter: z
    .object({
      column: z.number().int().min(1),
      equals: z.union([z.string(), z.number(), z.boolean()]).optional(),
      op: z
        .enum(['equals', 'not_equals', 'contains', 'gt', 'gte', 'lt', 'lte'])
        .optional()
        .describe(
          'Comparison. Default equals. Text ignores case and accents; dates are AAAA-MM-DD',
        ),
      value: z.union([z.string(), z.number(), z.boolean()]).optional(),
    })
    .refine((f) => f.equals !== undefined || f.value !== undefined, {
      message: 'El filtro necesita equals o value.',
    })
    .optional(),
  groupBy: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      'One-based column to group by (count, sum, average, min, max): returns one value per group',
    ),
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(100).default(30),
});

type FilterInput = NonNullable<z.infer<typeof tableQuerySchema>['filter']>;

const norm = (v: SheetValue | undefined) =>
  String(v ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .trim();

function matches(cell: SheetValue | undefined, filter: FilterInput): boolean {
  const op = filter.op ?? 'equals';
  const want = filter.value ?? filter.equals;
  if (op === 'equals' || op === 'not_equals') {
    const same =
      typeof want === 'string' || typeof cell === 'string'
        ? norm(cell) === norm(want as SheetValue)
        : cell === want;
    return op === 'equals' ? same : !same;
  }
  if (op === 'contains') return norm(cell).includes(norm(want as SheetValue));
  if (cell === null || cell === undefined || cell === '') return false;
  const both = typeof cell === 'number' && typeof want === 'number';
  const a = both ? (cell as number) : norm(cell);
  const b = both ? (want as number) : norm(want as SheetValue);
  return op === 'gt' ? a > b : op === 'gte' ? a >= b : op === 'lt' ? a < b : a <= b;
}

function numericValues(values: SheetValue[]): number[] {
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
  return numbers;
}

function aggregate(operation: 'sum' | 'average' | 'min' | 'max', numbers: number[]): number {
  const sum = numbers.reduce((a, b) => a + b, 0);
  const value =
    operation === 'sum'
      ? sum
      : operation === 'average'
        ? sum / numbers.length
        : operation === 'min'
          ? Math.min(...numbers)
          : Math.max(...numbers);
  if (!Number.isFinite(value)) throw new Error('El resultado supera el rango numérico admitido.');
  return value;
}

export function querySheet(sheets: SheetData[], input: z.infer<typeof tableQuerySchema>) {
  const sheet = sheets.find((s) => s.name === input.sheet);
  if (!sheet)
    throw new Error(
      `No existe esa hoja. Pestañas: ${sheets.map((s) => `«${s.name}»`).join(', ')}.`,
    );
  const width = Math.max(0, ...sheet.rows.map((r) => r.length));
  for (const column of [input.column, input.filter?.column, input.groupBy]) {
    if (column !== undefined && column > width) throw new Error('No existe esa columna.');
  }
  const rows = sheet.rows
    .slice(input.startRow - 1, input.endRow)
    .map((values, i) => ({ row: i + input.startRow, values }))
    .filter(
      ({ values }) => !input.filter || matches(values[input.filter.column - 1], input.filter),
    );
  const source = {
    sheet: sheet.name,
    matchedRows: rows.length,
    startRow: input.startRow,
    ...(input.endRow ? { endRow: input.endRow } : {}),
    filter: input.filter ?? null,
    // Si la pestaña tiene más filas de las leídas, el cálculo es sobre lo leído.
    ...(sheet.truncated
      ? {
          warning: `Esta pestaña tiene ${sheet.totalRows ?? '?'} filas y solo se guardaron ${sheet.rows.length}: el resultado es sobre las filas guardadas.`,
        }
      : {}),
    ...repeatedRows(rows),
  };
  if (input.operation === 'rows')
    return {
      ...source,
      rows: rows.slice(input.offset, input.offset + input.limit),
      hasMore: rows.length > input.offset + input.limit,
    };
  if (input.groupBy !== undefined) {
    const key = input.groupBy - 1;
    const groups = new Map<string, Array<{ values: SheetValue[] }>>();
    for (const r of rows) {
      const k = String(r.values[key] ?? '(vacío)');
      groups.set(k, [...(groups.get(k) ?? []), r]);
    }
    if (input.operation !== 'count' && input.column === undefined)
      throw new Error('Indica la columna para calcular.');
    const list = [...groups.entries()].map(([group, members]) => {
      if (input.operation === 'count')
        return { group, rows: members.length, value: members.length };
      const numbers = numericValues(
        members.map((m) => m.values[(input.column as number) - 1] ?? null),
      );
      return {
        group,
        rows: members.length,
        value: numbers.length ? aggregate(input.operation as 'sum', numbers) : null,
      };
    });
    list.sort(
      (a, b) => (b.value ?? Number.NEGATIVE_INFINITY) - (a.value ?? Number.NEGATIVE_INFINITY),
    );
    return {
      ...source,
      groupBy: input.groupBy,
      column: input.column ?? null,
      totalGroups: list.length,
      groups: list.slice(0, 50),
      hasMore: list.length > 50,
    };
  }
  if (input.operation === 'count') return { ...source, value: rows.length };
  if (input.column === undefined) throw new Error('Indica la columna para calcular.');
  const values: SheetValue[] = rows.map(
    ({ values }) => values[(input.column as number) - 1] ?? null,
  );
  const numbers = numericValues(values);
  if (!numbers.length) throw new Error('No hay valores numéricos en las filas seleccionadas.');
  const value = aggregate(input.operation, numbers);
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
