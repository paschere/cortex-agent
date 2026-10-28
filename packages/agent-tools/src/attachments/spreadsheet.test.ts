import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { chatSpreadsheetMime, parseColombianNumber, readChatSpreadsheet } from './spreadsheet';

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

async function book(build: (wb: ExcelJS.Workbook) => void): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  build(wb);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe('parseColombianNumber', () => {
  it('lee miles con punto y decimales con coma', () => {
    expect(parseColombianNumber('$ 1.234.567,89')).toBe(1234567.89);
    expect(parseColombianNumber('1.234')).toBe(1234);
    expect(parseColombianNumber('12,5')).toBe(12.5);
    expect(parseColombianNumber('(1.000)')).toBe(-1000);
    expect(parseColombianNumber('$ 1500')).toBe(1500);
  });
  it('no inventa números', () => {
    expect(parseColombianNumber('abc')).toBeNull();
    expect(parseColombianNumber('1500')).toBeNull();
    expect(parseColombianNumber('12-3')).toBeNull();
  });
});

describe('chatSpreadsheetMime', () => {
  it('manda la extensión', () => {
    expect(chatSpreadsheetMime('a.xlsx', '')).toBe(XLSX);
    expect(chatSpreadsheetMime('a.CSV', 'application/vnd.ms-excel')).toBe('text/csv');
    expect(chatSpreadsheetMime('a.xls', '')).toBe('application/vnd.ms-excel');
    expect(chatSpreadsheetMime('a.pdf', 'application/pdf')).toBeNull();
  });
});

describe('readChatSpreadsheet', () => {
  it('lee todas las pestañas, propaga combinadas y normaliza fechas y montos', async () => {
    const buffer = await book((wb) => {
      const a = wb.addWorksheet('2026');
      a.addRow(['Fecha', 'Cliente', 'Valor', 'NIT', 'Zona']);
      a.addRow([new Date(Date.UTC(2026, 2, 1)), 'Ana', '$ 1.234.567,50', '900.123.456', 'Norte']);
      a.addRow([new Date(Date.UTC(2026, 2, 2)), 'Beto', '2.000', '900.123.457', null]);
      a.addRow([new Date(Date.UTC(2026, 2, 3)), 'Cris', 3500, '900.123.458', null]);
      a.mergeCells('E2:E4');
      const b = wb.addWorksheet('Texto');
      b.addRow(['Día', 'Nota']);
      b.addRow(['31/12/2026', 'x']);
      b.addRow(['05/01/2027', 'y']);
    });
    const r = await readChatSpreadsheet(buffer, { name: 'ventas.xlsx', mime: XLSX });
    expect(r.tables.map((t) => t.name)).toEqual(['2026', 'Texto']);
    const rows = r.tables[0]?.rows ?? [];
    expect(rows[1]).toEqual(['2026-03-01', 'Ana', 1234567.5, '900.123.456', 'Norte']);
    expect(rows[2]?.[2]).toBe(2000);
    expect(rows[3]?.[4]).toBe('Norte'); // combinada propagada
    expect(r.tables[1]?.rows[1]?.[0]).toBe('2026-12-31');
    expect(r.truncated).toBe(false);
    expect(r.summary).toContain('«2026»');
    expect(r.summary).toContain('Valor (número, 3)');
    expect(r.summary).toContain('Fecha (fecha, 3)');
    expect(r.summary).toContain('feed_table_query');
  });

  it('lee un CSV con punto y coma', async () => {
    const csv = Buffer.from('Producto;Precio\nA;10\nB;20\n');
    const r = await readChatSpreadsheet(csv, { name: 'p.csv', mime: 'text/csv' });
    expect(r.tables[0]?.rows).toEqual([
      ['Producto', 'Precio'],
      ['A', 10],
      ['B', 20],
    ]);
  });

  it('quita filas y columnas vacías del final', async () => {
    const buffer = await book((wb) => {
      const s = wb.addWorksheet('S');
      s.addRow(['a', 'b', null]);
      s.addRow([1, 2, null]);
      s.addRow([null, null, null]);
    });
    const r = await readChatSpreadsheet(buffer, { name: 's.xlsx', mime: XLSX });
    expect(r.tables[0]?.rows).toEqual([
      ['a', 'b'],
      [1, 2],
    ]);
  });

  it('un .xls antiguo y un archivo protegido dan mensajes distintos', async () => {
    const cfb = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0, 0, 0, 0, 1, 2, 3]);
    await expect(
      readChatSpreadsheet(cfb, { name: 'a.xls', mime: 'application/vnd.ms-excel' }),
    ).rejects.toThrow(/\.xls\) y no lo puedo leer/);
    await expect(readChatSpreadsheet(cfb, { name: 'a.xlsx', mime: XLSX })).rejects.toThrow(
      /contraseña/,
    );
  });

  it('rechaza lo demasiado grande, lo vacío y lo que no es Excel', async () => {
    await expect(
      readChatSpreadsheet(Buffer.alloc(10 * 1024 * 1024 + 1), { name: 'a.xlsx', mime: XLSX }),
    ).rejects.toThrow(/10 MB/);
    await expect(
      readChatSpreadsheet(Buffer.from(new TextEncoder().encode('hola')), { name: 'a.xlsx', mime: XLSX }),
    ).rejects.toThrow(/no parece un Excel/);
    const empty = await book((wb) => {
      wb.addWorksheet('Vacía');
    });
    await expect(readChatSpreadsheet(empty, { name: 'a.xlsx', mime: XLSX })).rejects.toThrow(
      /no tiene datos/,
    );
  });

  it('dice cuántas filas de datos leyó', async () => {
    const buffer = await book((wb) => {
      const s = wb.addWorksheet('Grande');
      s.addRow(['n']);
      for (let i = 1; i <= 120; i++) s.addRow([i]);
    });
    const r = await readChatSpreadsheet(buffer, { name: 'g.xlsx', mime: XLSX });
    expect(r.tables[0]?.rows.length).toBe(121);
    expect(r.sheets[0]?.truncated).toBe(false);
    expect(r.summary).toContain('leí las 120 filas');
  });
});
