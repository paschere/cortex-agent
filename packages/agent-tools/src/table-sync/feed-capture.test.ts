import { describe, expect, it, vi } from 'vitest';

const sheets = vi.hoisted(() => vi.fn());
vi.mock('../gsheets/client', () => ({ sheetsFetch: sheets }));
vi.mock('../files/store', () => ({ putFile: vi.fn(), removeFiles: vi.fn() }));

import type { ToolContext } from '../types';
import {
  FeedCaptureError,
  captureGoogleSheetFeed,
  hashConfig,
  parseGoogleSheetRef,
  readGoogleSheetFeed,
  readGoogleSheetTab,
  sheetSourceConfig,
} from './feed-capture';

const ID = 'abcdefghijklmnopqrstuvwx_-123';

describe('parseGoogleSheetRef', () => {
  it('acepta la URL completa, con o sin pestaña, y el id suelto', () => {
    expect(parseGoogleSheetRef(`https://docs.google.com/spreadsheets/d/${ID}/edit#gid=0`)).toBe(ID);
    expect(parseGoogleSheetRef(`  https://docs.google.com/spreadsheets/d/${ID}  `)).toBe(ID);
    expect(parseGoogleSheetRef(ID)).toBe(ID);
  });
  it('no adivina: otras URLs, carpetas de Drive y nombres sueltos son null', () => {
    expect(parseGoogleSheetRef('https://drive.google.com/drive/folders/abc123')).toBeNull();
    expect(
      parseGoogleSheetRef(`https://docs.google.com.evil.test/spreadsheets/d/${ID}`),
    ).toBeNull();
    expect(parseGoogleSheetRef('ventas de septiembre')).toBeNull();
    expect(parseGoogleSheetRef('corto')).toBeNull();
  });
});

/** Un db mínimo: encadena filtros y responde lo que cada tabla tenga preparado. */
function fakeDb(opts: { duplicate?: { id: string } | null; count?: number }) {
  const sources: Array<Record<string, unknown>> = [];
  const inserted: Array<Record<string, unknown>> = [];
  const chain = (table: string) => {
    const q: Record<string, unknown> = {};
    let op = 'select';
    let head = false;
    let payload: Record<string, unknown> | null = null;
    const self = new Proxy(q, {
      get(_t, prop: string) {
        if (prop === 'then') {
          const result = (() => {
            if (table === 'chat_attachments') {
              if (op === 'insert') {
                inserted.push(payload as Record<string, unknown>);
                return { data: { id: 'new-attachment' }, error: null };
              }
              if (head) return { count: opts.count ?? 0, error: null };
              return { data: opts.duplicate ?? null, error: null };
            }
            if (table === 'feed_sources') {
              if (op === 'insert') {
                sources.push(payload as Record<string, unknown>);
                return { data: { id: 'source-1' }, error: null };
              }
              // La búsqueda por config_hash no encuentra nada: es una fuente nueva.
              return { data: op === 'select' ? null : { id: 'source-1' }, error: null };
            }
            return { data: null, error: null };
          })();
          return (resolve: (v: unknown) => void) => resolve(result);
        }
        return (...args: unknown[]) => {
          if (prop === 'insert') {
            op = 'insert';
            payload = args[0] as Record<string, unknown>;
          } else if (prop === 'update') op = 'update';
          else if (prop === 'select' && (args[1] as { head?: boolean } | undefined)?.head)
            head = true;
          return self;
        };
      },
    });
    return self;
  };
  return { db: { from: chain } as never, sources, inserted };
}

const ctx = {} as ToolContext;

function sheetResponses() {
  sheets.mockReset();
  sheets
    .mockResolvedValueOnce({
      properties: { title: 'Llegadas' },
      sheets: [{ properties: { title: 'Hoy', gridProperties: { rowCount: 10, columnCount: 3 } } }],
    })
    .mockResolvedValueOnce({
      values: [
        ['Vuelo', 'Hora'],
        ['AV9', '10:00'],
        ['LA1', '11:30'],
      ],
    });
}

describe('captureGoogleSheetFeed', () => {
  it('devuelve las pestañas con encabezados y filas, y el id de la fuente', async () => {
    sheetResponses();
    const { db, sources } = fakeDb({});
    const out = await captureGoogleSheetFeed({ db, ctx, actorId: 'u1', spreadsheetId: ID });
    expect(out).toMatchObject({
      sourceId: 'source-1',
      attachmentId: 'new-attachment',
      name: 'Llegadas',
      deduplicated: false,
      tables: [{ sheet: 0, name: 'Hoy', headers: ['Vuelo', 'Hora'], rows: 2 }],
    });
    // El hash tiene que ser el que escribe el Feed, o la fuente se duplica.
    expect(sources[0]?.config_hash).toBe(hashConfig({ spreadsheetId: ID }));
  });

  it('si el contenido ya estaba capturado lo reutiliza en vez de insertar', async () => {
    sheetResponses();
    const { db, inserted } = fakeDb({ duplicate: { id: 'old-attachment' } });
    const out = await captureGoogleSheetFeed({ db, ctx, actorId: 'u1', spreadsheetId: ID });
    expect(out.deduplicated).toBe(true);
    expect(out.attachmentId).toBe('old-attachment');
    expect(inserted).toHaveLength(0);
  });

  it('respeta el tope de 100 entradas del Feed', async () => {
    sheetResponses();
    const { db } = fakeDb({ count: 100 });
    await expect(
      captureGoogleSheetFeed({ db, ctx, actorId: 'u1', spreadsheetId: ID }),
    ).rejects.toBeInstanceOf(FeedCaptureError);
  });
});

describe('readGoogleSheetTab', () => {
  const six = ['Resumen', 'VUELOS DIARIOS DE MERFLEX', 'Históricos', 'Tarifas', 'Clientes', 'Otros'];
  const meta = {
    properties: { title: 'Operación' },
    sheets: six.map((title) => ({
      properties: { title, gridProperties: { rowCount: 30_000, columnCount: 30 } },
    })),
  };

  it('elige por nombre sin distinguir mayúsculas, tildes ni espacios dobles, y pide sólo esa pestaña', async () => {
    sheets.mockReset();
    sheets.mockResolvedValueOnce(meta).mockResolvedValueOnce({ values: [['Vuelo'], ['AV1']] });
    const out = await readGoogleSheetTab(ctx, ID, { tab: 'historicos' });
    expect(out.tab).toBe('Históricos');
    expect(out.tabs).toHaveLength(6);
    expect(sheets).toHaveBeenCalledTimes(2);
    expect(sheets.mock.calls[1]?.[1]).toContain(encodeURIComponent("'Históricos'!A1:AZ301"));
    expect(out.truncated).toBe(true);
    const spaced = await (async () => {
      sheets.mockReset();
      sheets.mockResolvedValueOnce(meta).mockResolvedValueOnce({ values: [] });
      return readGoogleSheetTab(ctx, ID, { tab: '  vuelos   diarios de merflex ' });
    })();
    expect(spaced.tab).toBe('VUELOS DIARIOS DE MERFLEX');
  });

  it('acepta la más parecida sólo si es inequívoca; si no, lista las pestañas', async () => {
    sheets.mockReset();
    sheets.mockResolvedValueOnce(meta).mockResolvedValueOnce({ values: [] });
    expect((await readGoogleSheetTab(ctx, ID, { tab: 'merflex' })).tab).toBe(
      'VUELOS DIARIOS DE MERFLEX',
    );
    sheets.mockReset();
    sheets.mockResolvedValueOnce(meta);
    await expect(readGoogleSheetTab(ctx, ID, { tab: 'Inexistente' })).rejects.toThrow(
      /Pestañas de esa hoja:.*«Resumen».*«VUELOS DIARIOS DE MERFLEX».*«Otros»/,
    );
    sheets.mockReset();
    sheets.mockResolvedValueOnce(meta);
    await expect(readGoogleSheetTab(ctx, ID, { tab: 99 })).rejects.toThrow(/Pestañas de esa hoja/);
  });

  it('por índice', async () => {
    sheets.mockReset();
    sheets.mockResolvedValueOnce(meta).mockResolvedValueOnce({ values: [['x']] });
    expect((await readGoogleSheetTab(ctx, ID, { tab: 3 })).tab).toBe('Tarifas');
  });
});

describe('readGoogleSheetFeed con pestañas elegidas', () => {
  const meta = {
    properties: { title: 'Operación' },
    sheets: ['A', 'B', 'C', 'D', 'E', 'F'].map((title) => ({
      properties: { title, gridProperties: { rowCount: 12_000, columnCount: 10 } },
    })),
  };
  const block = (n: number) => Array.from({ length: n }, (_, i) => [`r${i}`, i]);

  it('lee sólo una pestaña de seis grandes, por bloques de 5000 filas', async () => {
    sheets.mockReset();
    sheets
      .mockResolvedValueOnce(meta)
      .mockResolvedValueOnce({ values: block(5000) })
      .mockResolvedValueOnce({ values: block(5000) })
      .mockResolvedValueOnce({ values: block(1500) });
    const out = await readGoogleSheetFeed(ctx, ID, { tabs: ['b'] });
    expect(out.selected).toEqual(['B']);
    expect(out.tables).toHaveLength(1);
    expect(out.tables[0]?.rows).toHaveLength(11_500);
    expect(sheets).toHaveBeenCalledTimes(4);
    expect(decodeURIComponent(String(sheets.mock.calls[1]?.[1]))).toContain("'B'!A1:AZ5000");
    expect(decodeURIComponent(String(sheets.mock.calls[2]?.[1]))).toContain("'B'!A5001:AZ10000");
    expect(decodeURIComponent(String(sheets.mock.calls[3]?.[1]))).toContain("'B'!A10001:AZ12000");
  });

  it('sin pestañas elegidas sigue leyendo todas con A1:AZ1000', async () => {
    sheets.mockReset();
    sheets.mockResolvedValueOnce(meta);
    for (let i = 0; i < 6; i++) sheets.mockResolvedValueOnce({ values: [['a']] });
    const out = await readGoogleSheetFeed(ctx, ID);
    expect(out.selected).toBeNull();
    expect(out.tables).toHaveLength(6);
    expect(decodeURIComponent(String(sheets.mock.calls[1]?.[1]))).toContain("'A'!A1:AZ1000");
  });

  it('captura sólo la pestaña y guarda tabs; sin tabs el config_hash es el de siempre', async () => {
    sheets.mockReset();
    sheets.mockResolvedValueOnce(meta).mockResolvedValueOnce({ values: [['Vuelo'], ['AV1']] });
    const { db, sources } = fakeDb({});
    const out = await captureGoogleSheetFeed({
      db,
      ctx,
      actorId: 'u1',
      spreadsheetId: ID,
      tabs: ['c'],
    });
    expect(out.tables).toEqual([{ sheet: 0, name: 'C', headers: ['Vuelo'], rows: 1 }]);
    expect(sources[0]?.config).toEqual({ spreadsheetId: ID, tabs: ['C'] });
    expect(sources[0]?.config_hash).toBe(hashConfig({ spreadsheetId: ID, tabs: ['C'] }));
    expect(sheetSourceConfig(ID)).toEqual({ spreadsheetId: ID });
    expect(hashConfig(sheetSourceConfig(ID, []))).toBe(hashConfig({ spreadsheetId: ID }));
  });
});
