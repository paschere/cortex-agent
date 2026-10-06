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
