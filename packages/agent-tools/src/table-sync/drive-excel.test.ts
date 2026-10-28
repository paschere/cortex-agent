import ExcelJS from 'exceljs';
import { describe, expect, it, vi } from 'vitest';

const sheets = vi.hoisted(() => vi.fn());
const drive = vi.hoisted(() => ({ get: vi.fn(), bytes: vi.fn() }));
vi.mock('../gsheets/client', () => ({ sheetsFetch: sheets }));
vi.mock('../gdrive/client', () => ({ driveGet: drive.get, driveGetBytes: drive.bytes }));
vi.mock('../files/store', () => ({ putFile: vi.fn(), removeFiles: vi.fn() }));

import { GoogleApiError, isExcelRejection } from '../gsheets/errors';
import type { ToolContext } from '../types';
import { isDriveSpreadsheetMime, sliceA1 } from './drive-excel';
import { readGoogleSheetFeed, readGoogleSheetTab } from './feed-capture';
import { describeSheetReadError } from './read-errors';

const ID = '1DQ6qtt7aOyXH8GyHW9lj5a18r0cem2CC';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function ctx(over: { email?: string | null; hasScopes?: boolean } = {}): ToolContext {
  return {
    logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    integrations: {
      hasScopes: vi.fn().mockResolvedValue(over.hasScopes ?? true),
      getAccessToken: vi.fn(),
      accountEmail: vi.fn().mockResolvedValue(over.email === undefined ? null : over.email),
    },
  } as unknown as ToolContext;
}

const excelError = () =>
  new GoogleApiError(
    'sheets',
    400,
    `/${ID}`,
    JSON.stringify({
      error: {
        code: 400,
        message: 'This operation is not supported for this document',
        status: 'FAILED_PRECONDITION',
      },
    }),
  );

async function sampleXlsx(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const a = wb.addWorksheet('Vuelos');
  a.addRow(['vuelo', 'fecha', 'peso']);
  a.addRow(['AV123', 'hoy', 12.5]);
  a.addRow(['LA456', 'mañana', 7]);
  const b = wb.addWorksheet('Otra');
  b.addRow(['x']);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function mockDriveExcel(bytes: Buffer, mimeType = XLSX) {
  sheets.mockReset();
  sheets.mockRejectedValue(excelError());
  drive.get.mockResolvedValue({
    id: ID,
    name: 'Merflex.xlsx',
    mimeType,
    modifiedTime: '2026-10-27T10:00:00Z',
    md5Checksum: 'abc',
    size: String(bytes.length),
  });
  drive.bytes.mockResolvedValue(bytes);
}

describe('detección', () => {
  it('reconoce el rechazo de Sheets por Excel y los mimeTypes de Drive', () => {
    expect(isExcelRejection(excelError())).toBe(true);
    expect(isExcelRejection(new GoogleApiError('sheets', 403, '/x', '{}'))).toBe(false);
    expect(isExcelRejection(new Error('x'))).toBe(false);
    expect(isDriveSpreadsheetMime(XLSX)).toBe(true);
    expect(isDriveSpreadsheetMime('application/vnd.ms-excel')).toBe(true);
    expect(isDriveSpreadsheetMime('text/csv')).toBe(true);
    expect(isDriveSpreadsheetMime('application/vnd.google-apps.spreadsheet')).toBe(false);
  });
});

describe('lectura por Drive', () => {
  it('lee un xlsx con las mismas pestañas, encabezados y filas', async () => {
    mockDriveExcel(await sampleXlsx());
    const read = await readGoogleSheetTab(ctx(), ID, { tab: 'vuelos' });
    expect(read.title).toBe('Merflex');
    expect(read.tab).toBe('Vuelos');
    expect(read.tabs.map((t) => t.title)).toEqual(['Vuelos', 'Otra']);
    expect(read.sheet.rows).toEqual([
      ['vuelo', 'fecha', 'peso'],
      ['AV123', 'hoy', 12.5],
      ['LA456', 'mañana', 7],
    ]);
    expect(read.truncated).toBe(false);
  });

  it('el feed completo trae todas las pestañas y la versión del archivo', async () => {
    mockDriveExcel(await sampleXlsx());
    const feed = await readGoogleSheetFeed(ctx(), ID);
    expect(feed.tables.map((t) => t.name)).toEqual(['Vuelos', 'Otra']);
    expect(feed.driveVersion).toBe('abc');
    expect(feed.text).toContain('AV123\thoy\t12.5');
  });

  it('con pestañas elegidas lee sólo esa', async () => {
    mockDriveExcel(await sampleXlsx());
    const feed = await readGoogleSheetFeed(ctx(), ID, { tabs: ['Vuelos'] });
    expect(feed.selected).toEqual(['Vuelos']);
    expect(feed.tables).toHaveLength(1);
  });

  it('una hoja nativa no toca Drive', async () => {
    sheets.mockReset();
    drive.get.mockReset();
    sheets
      .mockResolvedValueOnce({
        properties: { title: 'Nativa' },
        sheets: [{ properties: { title: 'A', gridProperties: { rowCount: 2, columnCount: 2 } } }],
      })
      .mockResolvedValueOnce({ values: [['h'], ['v']] });
    const read = await readGoogleSheetTab(ctx(), ID);
    expect(read.sheet.rows).toEqual([['h'], ['v']]);
    expect(drive.get).not.toHaveBeenCalled();
  });

  it('un .xls antiguo da un error claro', async () => {
    mockDriveExcel(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0, 0, 0, 0]), 'application/vnd.ms-excel');
    await expect(readGoogleSheetTab(ctx(), ID)).rejects.toThrow(/\.xls/);
  });

  it('un CSV en Drive se lee', async () => {
    mockDriveExcel(Buffer.from('a,b\n1,2\n'), 'text/csv');
    const read = await readGoogleSheetTab(ctx(), ID);
    expect(read.sheet.rows).toEqual([
      ['a', 'b'],
      [1, 2],
    ]);
  });
});

describe('sliceA1', () => {
  const data = [
    {
      name: 'Hoja 1',
      rows: [
        ['a', 'b', 'c'],
        [1, 2, 3],
        [4, 5, 6],
      ],
    },
  ];
  it('recorta rangos', () => {
    expect(sliceA1(data, "'Hoja 1'!A2:B3")).toEqual([
      ['1', '2'],
      ['4', '5'],
    ]);
    expect(sliceA1(data, 'B:B')).toEqual([['b'], ['2'], ['5']]);
    expect(sliceA1(data, 'Hoja 1')).toHaveLength(3);
    expect(() => sliceA1(data, 'Otra!A1')).toThrow(/Pestañas/);
  });
});

describe('errores honestos', () => {
  it('403: dice con qué cuenta compartir', async () => {
    const e = await describeSheetReadError(
      ctx({ email: 'cortex@empresa.co' }),
      new GoogleApiError('sheets', 403, '/x', '{"error":{"status":"PERMISSION_DENIED"}}'),
    );
    expect(e.message).toContain('cortex@empresa.co');
    expect(e.message).toMatch(/Compártelo/);
  });
  it('403 sin correo conocido igual orienta', async () => {
    const e = await describeSheetReadError(ctx(), new GoogleApiError('sheets', 403, '/x', '{}'));
    expect(e.message).toMatch(/Compártelo con la cuenta/);
  });
  it('404: no existe o enlace mal copiado', async () => {
    const e = await describeSheetReadError(ctx(), new GoogleApiError('sheets', 404, '/x', '{}'));
    expect(e.message).toMatch(/no existe/);
    expect(e.message).toMatch(/enlace/);
  });
  it('falta el scope de Drive: lo dice y cómo reconectar', async () => {
    const e = await describeSheetReadError(
      ctx(),
      new GoogleApiError('drive', 403, '/files/x', '{"error":{"errors":[{"reason":"insufficientPermissions"}]}}'),
    );
    expect(e.message).toMatch(/permiso de Drive/);
    expect(e.message).toMatch(/Reconecta Google/);
  });
  it('sin conexión de Google', async () => {
    const e = await describeSheetReadError(ctx({ hasScopes: false }), new Error('No google integration'));
    expect(e.message).toMatch(/no está conectado/);
  });
});
