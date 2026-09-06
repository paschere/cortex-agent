import { ValidationError } from '@cortex/core';
import { describe, expect, it } from 'vitest';
import { parseDocument } from './parsers';

describe('parseDocument', () => {
  it('returns plain text unchanged', async () => {
    const result = await parseDocument(Buffer.from('hello world'), 'text/plain');
    expect(result.text).toBe('hello world');
    expect(result.pages).toBeUndefined();
  });

  it('returns markdown text unchanged', async () => {
    const result = await parseDocument(Buffer.from('# heading\n\nsome text'), 'text/markdown');
    expect(result.text).toContain('# heading');
    expect(result.text).toContain('some text');
  });

  it('preserves CSV as structured cells', async () => {
    const result = await parseDocument(Buffer.from('name,age\nalice,30'), 'text/csv');
    expect(result.tables?.[0]?.rows).toEqual([
      ['name', 'age'],
      ['alice', 30],
    ]);
    expect(result.text).toContain('suma 30');
    expect(result.pages).toBeUndefined();
  });

  it('throws ValidationError for unsupported mime type', async () => {
    await expect(parseDocument(Buffer.from(''), 'application/octet-stream')).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('throws ValidationError with message containing the mime type', async () => {
    await expect(parseDocument(Buffer.from(''), 'image/png')).rejects.toThrow('image/png');
  });
});

describe('spreadsheets', () => {
  it('keeps every worksheet, empty cell positions, types and cached formula results', async () => {
    const { default: ExcelJS } = await import('exceljs');
    const book = new ExcelJS.Workbook();
    const sheet = book.addWorksheet('Ventas');
    sheet.addRow(['Cliente', 'Monto', 'Referencia', 'Total']);
    sheet.addRow(['Acme', 25, null, { formula: 'B2*2', result: 50 }]);
    sheet.addRow(['Beta', 10, '00123', { formula: 'B3*2' }]);
    book.addWorksheet('Otra').addRow(['Nota', true]);
    const bytes = Buffer.from(await book.xlsx.writeBuffer());
    const result = await parseDocument(
      bytes,
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    expect(result.tables).toHaveLength(2);
    expect(result.tables?.[0]?.rows[1]).toEqual(['Acme', 25, null, 50]);
    expect(result.tables?.[0]?.rows[2]?.[3]).toBe('[Fórmula sin resultado guardado]');
    expect(result.tables?.[1]?.rows[0]).toEqual(['Nota', true]);
  });
  it('handles quoted commas, multiline cells and leading-zero identifiers', async () => {
    const result = await parseDocument(
      Buffer.from('id,nota,monto\n00123,"hola,\nmundo",20'),
      'text/csv',
    );
    expect(result.tables?.[0]?.rows[1]).toEqual(['00123', 'hola,\nmundo', 20]);
  });
});
