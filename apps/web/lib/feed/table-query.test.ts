import { describe, expect, it } from 'vitest';
import { querySheet, tableQuerySchema } from './table-query';

const sheets = [
  {
    name: 'Ventas',
    rows: [
      ['Cliente', 'Venta'],
      ...Array.from({ length: 1000 }, (_, i) => [i % 2 ? 'A' : 'B', 10]),
    ],
  },
];
const input = (extra = {}) =>
  tableQuerySchema.parse({
    attachmentId: 'a',
    sheet: 'Ventas',
    operation: 'sum',
    column: 2,
    ...extra,
  });
describe('complete Feed tables', () => {
  it('makes repeated rows explicit without deleting potentially legitimate transactions', () => {
    expect(querySheet(sheets, input())).toMatchObject({
      duplicateRowCount: 998,
      requiresDuplicateReview: true,
      value: 10000,
    });
  });
  it('calculates beyond the preview and prompt limits', () => {
    expect(querySheet(sheets, input())).toMatchObject({ value: 10000, matchedRows: 1000 });
    expect(querySheet(sheets, input({ filter: { column: 1, equals: 'A' } }))).toMatchObject({
      value: 5000,
      matchedRows: 500,
    });
  });
  it('pages rows with original row numbers', () => {
    expect(querySheet(sheets, input({ operation: 'rows', offset: 100, limit: 1 }))).toMatchObject({
      rows: [{ row: 102, values: ['B', 10] }],
      hasMore: true,
    });
  });
  it('does not present a partial sum when locale strings or formulas are unreadable', () => {
    expect(() =>
      querySheet([{ name: 'Ventas', rows: [['Monto'], [10], ['1.500,00']] }], input({ column: 1 })),
    ).toThrow('no numéricos');
  });
  it('rejects missing sheets and out-of-range columns', () => {
    expect(() => querySheet(sheets, input({ column: 100 }))).toThrow('columna');
    expect(() => querySheet(sheets, input({ sheet: 'Otra' }))).toThrow('hoja');
  });
});
