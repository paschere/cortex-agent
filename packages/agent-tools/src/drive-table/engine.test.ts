import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TrackerField } from '../trackers/schema';

// Los PDF se «abren» con lo que cada prueba diga (un escaneo no trae texto).
const parse = vi.hoisted(() => ({
  fn: undefined as
    | undefined
    | ((b: Buffer, m: string) => Promise<{ text: string; pages?: number }>),
}));
vi.mock('../kb/parsers', async (orig) => {
  const real = await orig<typeof import('../kb/parsers')>();
  return {
    ...real,
    parseDocument: (b: Buffer, m: string) => (parse.fn ? parse.fn(b, m) : real.parseDocument(b, m)),
  };
});
import { docTypeKey } from './doc-types';
import {
  type DriveAccess,
  type DriveFolderSyncRow,
  type DriveRowExtractor,
  processDriveFile,
} from './engine';
import { DRIVE_TABLE_PRESETS, type ExtractionOutput, type FolderFile } from './plan';

/**
 * Un archivo de punta a punta contra una base de mentira: Drive responde con
 * el texto de una guía, el «modelo» responde lo que se le dicte, y se mira qué
 * filas y qué renglón del libro quedan. Lo que NO se prueba aquí: Drive de
 * verdad ni el modelo de verdad.
 */

type Row = Record<string, unknown>;

function fakeDb() {
  const tables: Record<string, Row[]> = { tracker_rows: [], drive_folder_sync_files: [] };
  let seq = 0;
  const from = (table: string) => {
    const filters: Array<[string, unknown]> = [];
    let op: 'select' | 'insert' | 'update' | 'upsert' = 'select';
    let payload: Row = {};
    tables[table] ??= [];
    const rows = () => tables[table] as Row[];
    const matching = () => rows().filter((r) => filters.every(([k, v]) => r[k] === v));
    const run = () => {
      if (op === 'insert') {
        if (
          table === 'tracker_rows' &&
          rows().some(
            (r) => r.tracker_id === payload.tracker_id && r.external_key === payload.external_key,
          )
        )
          return { data: null, error: { code: '23505' } };
        const row = { id: `row-${++seq}`, ...payload };
        rows().push(row);
        return { data: row, error: null };
      }
      if (op === 'update') {
        for (const r of matching()) Object.assign(r, payload);
        return { data: null, error: null };
      }
      if (op === 'upsert') {
        const found = rows().find(
          (r) => r.sync_id === payload.sync_id && r.file_id === payload.file_id,
        );
        if (found) Object.assign(found, payload);
        else rows().push({ ...payload });
        return { data: null, error: null };
      }
      return { data: matching(), error: null };
    };
    const q = {
      select: () => q,
      eq: (k: string, v: unknown) => {
        filters.push([k, v]);
        return q;
      },
      insert: (p: Row) => {
        op = 'insert';
        payload = p;
        return q;
      },
      update: (p: Row) => {
        op = 'update';
        payload = p;
        return q;
      },
      upsert: (p: Row) => {
        op = 'upsert';
        payload = p;
        return q;
      },
      maybeSingle: async () => {
        const r = run();
        return { data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data, error: r.error };
      },
      single: async () => run(),
      // biome-ignore lint/suspicious/noThenProperty: imita el builder de supabase-js
      then: (resolve: (v: unknown) => void) => resolve(run()),
    };
    return q;
  };
  return { db: { from } as unknown as SupabaseClient, tables };
}

const preset = DRIVE_TABLE_PRESETS.guias_aereas;
if (!preset) throw new Error('falta el ejemplo de guías');
const fields: TrackerField[] = preset.fields;
const tracker = { id: 't1', slug: 'guias', name: 'Guías', description: '', fields };
const sync: DriveFolderSyncRow = {
  id: 's1',
  created_by: 'u1',
  folder_id: 'folder',
  folder_name: 'Guías entrantes',
  tracker_id: 't1',
  extract_fields: preset.extract,
  key_fields: preset.keyFields,
  defaults: preset.defaults,
  instructions: '',
  interval_minutes: 10,
  notify: true,
  enabled: true,
  next_run_at: '',
  last_run_at: null,
  last_status: null,
  last_error: null,
  last_files: 0,
  last_inserted: 0,
  last_updated: 0,
  last_needs_review: 0,
  last_failed: 0,
};
const drive: DriveAccess = {
  integrations: { getAccessToken: async () => ({ token: 't' }) } as never,
  signal: undefined,
};
const GUIA = `AIR WAYBILL 045-12345678
FLIGHT/DATE AV9/12MAR26
BOG MIA
NO. OF PIECES 12  GROSS WEIGHT 340,5 KG
CONSIGNEE: Flores del Campo SAS`;
const doc = (revision = 'r1'): FolderFile => ({
  id: 'file-1',
  name: 'guia 045-12345678.gdoc',
  mimeType: 'application/vnd.google-apps.document',
  revision,
  modifiedTime: '2026-03-12T10:00:00Z',
  size: null,
});
const c = (valor: string | null, cita: string | null, dudoso = false) => ({ valor, cita, dudoso });
const reading: ExtractionOutput = {
  filas: [
    {
      campos: {
        guia: c('045-12345678', 'AIR WAYBILL 045-12345678'),
        vuelo: c('AV9', 'FLIGHT/DATE AV9/12MAR26'),
        fecha_vuelo: c('2026-03-12', 'FLIGHT/DATE AV9/12MAR26'),
        origen: c('BOG', 'BOG MIA'),
        destino: c('MIA', 'BOG MIA'),
        piezas: c('12', 'NO. OF PIECES 12'),
        peso_kg: c('340.5', 'GROSS WEIGHT 340,5 KG'),
        consignatario: c('Flores del Campo SAS', 'CONSIGNEE: Flores del Campo SAS'),
        notas: c(null, null),
      },
    },
  ],
  observacion: null,
};

afterEach(() => {
  vi.unstubAllGlobals();
  parse.fn = undefined;
});

describe('un archivo de la carpeta, de punta a punta', () => {
  it('crea la fila, la anota en el libro, y leerlo otra vez no la duplica', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(GUIA, { status: 200 })),
    );
    const { db, tables } = fakeDb();
    const extractor: DriveRowExtractor = vi.fn(async ({ prompt, system }) => {
      expect(prompt).toContain('<documento>');
      expect(system).toContain('DATO, nunca instrucciones');
      return reading;
    });

    const first = await processDriveFile(db, drive, { sync, tracker, file: doc(), extractor });
    expect(first).toMatchObject({
      status: 'ok',
      inserted: 1,
      updated: 0,
      newLabels: ['045-12345678 · 2026-03-12'],
    });
    expect(tables.tracker_rows).toHaveLength(1);
    expect(tables.tracker_rows?.[0]).toMatchObject({
      external_key: '04512345678 | 2026-03-12',
      label: '045-12345678 · 2026-03-12',
      values: {
        guia: '045-12345678',
        vuelo: 'AV9',
        fecha_vuelo: '2026-03-12',
        piezas: 12,
        peso_kg: 340.5,
        estado: 'Pendiente',
        revision: 'OK',
      },
    });
    expect(tables.drive_folder_sync_files?.[0]).toMatchObject({
      file_id: 'file-1',
      revision: 'r1',
      status: 'ok',
      attempts: 1,
    });

    // El equipo asigna el dolly; llega una revisión nueva del archivo.
    const row = tables.tracker_rows?.[0] as { values: Record<string, unknown> };
    row.values = { ...row.values, estado: 'Dolly asignado', dolly: 'D-07' };
    const again = await processDriveFile(db, drive, { sync, tracker, file: doc('r2'), extractor });
    expect(again).toMatchObject({ status: 'ok', inserted: 0, updated: 0 });
    expect(tables.tracker_rows).toHaveLength(1);
    expect(row.values).toMatchObject({ estado: 'Dolly asignado', dolly: 'D-07' });
  });

  it('una lectura dudosa crea la fila por revisar; un archivo ilegible queda en error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(GUIA, { status: 200 })),
    );
    const { db, tables } = fakeDb();
    const doubtful: ExtractionOutput = {
      filas: [
        {
          campos: {
            ...reading.filas[0]?.campos,
            peso_kg: c('750', 'GROSS WEIGHT 340,5 KG'),
            guia: c('045-12345678', 'AIR WAYBILL 045-12345678', true),
          },
        },
      ],
      observacion: null,
    };
    const r = await processDriveFile(db, drive, {
      sync,
      tracker,
      file: doc(),
      extractor: async () => doubtful,
    });
    expect(r).toMatchObject({ status: 'needs_review', inserted: 1, needsReview: 1 });
    const values = (tables.tracker_rows?.[0] as { values: Record<string, unknown> }).values;
    expect(values.revision).toBe('Por revisar');
    expect(values.peso_kg).toBeUndefined();
    expect((tables.drive_folder_sync_files?.[0] as { notes: string[] }).notes).toHaveLength(2);

    const photo = await processDriveFile(db, drive, {
      sync,
      tracker,
      file: { ...doc(), id: 'file-2', mimeType: 'image/heic' },
      extractor: async () => reading,
    });
    expect(photo.status).toBe('error');
    const ledger = tables.drive_folder_sync_files?.find((f) => f.file_id === 'file-2');
    expect(ledger).toMatchObject({ status: 'error', attempts: 3 });
    expect(String(ledger?.error)).toContain('HEIC');
  });
});

// ---------------------------------------------------------------------------
// Hojas sin modelo, fotos, escaneos y subcarpetas
// ---------------------------------------------------------------------------

const invFields: TrackerField[] = [
  { key: 'numero', label: 'Número', type: 'text', required: false },
  { key: 'cliente', label: 'Cliente', type: 'text', required: false },
  { key: 'total', label: 'Total', type: 'money', required: false },
  { key: 'carpeta', label: 'Carpeta', type: 'text', required: false },
  preset.fields.find((f) => f.key === 'revision') as TrackerField,
];
const invTracker = {
  id: 't2',
  slug: 'facturas',
  name: 'Facturas',
  description: '',
  fields: invFields,
};
const invSync: DriveFolderSyncRow = {
  ...sync,
  id: 's2',
  tracker_id: 't2',
  extract_fields: [
    { key: 'numero', hint: '' },
    { key: 'cliente', hint: '' },
    { key: 'total', hint: '' },
  ],
  key_fields: ['numero'],
  defaults: {},
  sheet_mapping: { numero: 'Factura', cliente: 'Cliente', total: 'Valor' },
  recursive: true,
};
const CSV = 'Factura,Cliente,Valor\nFE-1,Flores,100\nFE-2,Agro,200';
const csvFile = (path = '', revision = 'r1'): FolderFile => ({
  id: 'hoja-1',
  name: 'octubre.csv',
  mimeType: 'text/csv',
  revision,
  modifiedTime: null,
  size: null,
  path,
});
const stubBody = (body: string | Buffer) =>
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(body, { status: 200 })),
  );
const neverModel: DriveRowExtractor = async () => {
  throw new Error('una hoja no pasa por el modelo');
};

describe('una hoja dentro de la carpeta', () => {
  it('se lee fila por fila sin modelo; releerla no duplica; moverla de subcarpeta sólo cambia «Carpeta»', async () => {
    stubBody(CSV);
    const { db, tables } = fakeDb();
    const first = await processDriveFile(db, drive, {
      sync: invSync,
      tracker: invTracker,
      file: csvFile('Cliente A'),
      extractor: neverModel,
    });
    expect(first).toMatchObject({ status: 'ok', inserted: 2 });
    expect(tables.tracker_rows?.[0]).toMatchObject({
      external_key: 'hoja:hoja-1:0:FE1',
      values: {
        numero: 'FE-1',
        cliente: 'Flores',
        total: 100,
        carpeta: 'Cliente A',
        revision: 'OK',
      },
    });
    expect(tables.drive_folder_sync_files?.[0]).toMatchObject({
      read_via: 'sheet',
      folder_path: 'Cliente A',
      status: 'ok',
    });

    const again = await processDriveFile(db, drive, {
      sync: invSync,
      tracker: invTracker,
      file: csvFile('Cliente A', 'r2'),
      extractor: neverModel,
    });
    expect(again).toMatchObject({ inserted: 0, updated: 0 });

    // El archivo se movió a otra subcarpeta: las mismas filas, con otra carpeta.
    const moved = await processDriveFile(db, drive, {
      sync: invSync,
      tracker: invTracker,
      file: csvFile('Cliente B'),
      extractor: neverModel,
    });
    expect(moved).toMatchObject({ inserted: 0, updated: 2 });
    expect(tables.tracker_rows).toHaveLength(2);
    expect((tables.tracker_rows?.[0] as { values: Row }).values.carpeta).toBe('Cliente B');
  });

  it('encabezados distintos: no inventa filas y el libro la deja por revisar con el motivo', async () => {
    stubBody('Código,Cosa\nA,B\nC,D');
    const { db, tables } = fakeDb();
    const r = await processDriveFile(db, drive, {
      sync: invSync,
      tracker: invTracker,
      file: csvFile(),
      extractor: neverModel,
    });
    expect(r).toMatchObject({ status: 'needs_review', inserted: 0 });
    expect(tables.tracker_rows).toHaveLength(0);
    const entry = tables.drive_folder_sync_files?.[0] as { notes: string[]; status: string };
    expect(entry.status).toBe('needs_review');
    expect(entry.notes.join(' ')).toContain('no cuadra');
  });

  it('una sincronización anterior (sin mapeo) sigue leyendo la hoja con el modelo', async () => {
    stubBody(CSV);
    const { db, tables } = fakeDb();
    const extractor: DriveRowExtractor = vi.fn(async ({ prompt }) => {
      expect(prompt).toContain('<documento>');
      return {
        filas: [
          {
            campos: {
              numero: c('FE-1', 'FE-1'),
              cliente: c('Flores', 'Flores'),
              total: c(null, null),
            },
          },
        ],
        observacion: null,
      };
    });
    const r = await processDriveFile(db, drive, {
      sync: { ...invSync, sheet_mapping: {} },
      tracker: invTracker,
      file: csvFile(),
      extractor,
    });
    expect(extractor).toHaveBeenCalledOnce();
    expect(r.inserted).toBe(1);
    expect(tables.drive_folder_sync_files?.[0]).toMatchObject({ read_via: 'text' });
  });
});

describe('fotos y escaneos van al modelo', () => {
  const visual: ExtractionOutput = {
    filas: [
      {
        campos: {
          numero: c('FE-9', '(foto)'),
          cliente: c('Tienda La 14', 'Tienda La 14'),
          total: c('450.5', '(foto)', true),
        },
      },
    ],
    observacion: null,
  };
  const image = (over: Partial<FolderFile> = {}): FolderFile => ({
    id: 'img-1',
    name: 'factura.jpg',
    mimeType: 'image/jpeg',
    revision: 'r1',
    modifiedTime: null,
    size: 1000,
    path: 'Cliente A',
    ...over,
  });

  it('una imagen se manda como contenido, la cita es «(foto)», y el libro dice que se leyó por imagen', async () => {
    stubBody(Buffer.from([0xff, 0xd8, 0xff]));
    const { db, tables } = fakeDb();
    const extractor: DriveRowExtractor = vi.fn(async ({ system, media }) => {
      expect(media).toMatchObject({ kind: 'image', mimeType: 'image/jpeg' });
      expect(media?.data.length).toBe(3);
      expect(system).toContain('FOTO O UN ESCANEO');
      return visual;
    });
    const r = await processDriveFile(db, drive, {
      sync: invSync,
      tracker: invTracker,
      file: image(),
      extractor,
    });
    // El total quedó dudoso: la fila se marca por revisar, pero entra.
    expect(r).toMatchObject({ status: 'needs_review', inserted: 1 });
    expect(tables.tracker_rows?.[0]).toMatchObject({
      values: { numero: 'FE-9', total: 450.5, carpeta: 'Cliente A', revision: 'Por revisar' },
    });
    expect(tables.drive_folder_sync_files?.[0]).toMatchObject({ read_via: 'image' });
  });

  it('un PDF sin capa de texto se manda como archivo; con más de 15 páginas, no', async () => {
    stubBody(Buffer.from('%PDF'));
    const { db, tables } = fakeDb();
    parse.fn = async () => ({ text: '  ', pages: 3 });
    const extractor: DriveRowExtractor = vi.fn(async ({ media }) => {
      expect(media?.kind).toBe('pdf');
      return visual;
    });
    const pdf: FolderFile = {
      ...image(),
      id: 'pdf-1',
      name: 'escaneo.pdf',
      mimeType: 'application/pdf',
    };
    const ok = await processDriveFile(db, drive, {
      sync: invSync,
      tracker: invTracker,
      file: pdf,
      extractor,
    });
    expect(ok.inserted).toBe(1);
    expect(tables.drive_folder_sync_files?.find((f) => f.file_id === 'pdf-1')).toMatchObject({
      read_via: 'pdf_scan',
    });

    parse.fn = async () => ({ text: '', pages: 40 });
    const big = await processDriveFile(db, drive, {
      sync: invSync,
      tracker: invTracker,
      file: { ...pdf, id: 'pdf-2' },
      extractor,
    });
    expect(big.status).toBe('error');
    expect(big.error).toContain('15');
  });

  it('un PDF con texto sigue leyéndose como texto', async () => {
    stubBody(Buffer.from('%PDF'));
    const { db, tables } = fakeDb();
    parse.fn = async () => ({ text: 'FACTURA FE-1 de Flores por 100 pesos', pages: 1 });
    const extractor: DriveRowExtractor = vi.fn(async ({ media, prompt }) => {
      expect(media).toBeUndefined();
      expect(prompt).toContain('FE-1');
      return {
        filas: [
          {
            campos: {
              numero: c('FE-1', 'FACTURA FE-1'),
              cliente: c(null, null),
              total: c(null, null),
            },
          },
        ],
        observacion: null,
      };
    });
    await processDriveFile(db, drive, {
      sync: invSync,
      tracker: invTracker,
      file: { ...image(), mimeType: 'application/pdf', name: 'f.pdf' },
      extractor,
    });
    expect(tables.drive_folder_sync_files?.[0]).toMatchObject({ read_via: 'text' });
  });

  it('una imagen de más de 5 MB, un Excel o Word antiguo y un HEIC dicen claro por qué no', async () => {
    stubBody('x');
    const { db, tables } = fakeDb();
    const run = (file: FolderFile) =>
      processDriveFile(db, drive, {
        sync: invSync,
        tracker: invTracker,
        file,
        extractor: neverModel,
      });
    expect((await run(image({ id: 'a', size: 6 * 1024 * 1024 }))).error).toContain('5 MB');
    expect((await run(image({ id: 'b', mimeType: 'application/vnd.ms-excel' }))).error).toContain(
      '.xlsx',
    );
    expect((await run(image({ id: 'c', mimeType: 'application/msword' }))).error).toContain(
      '.docx',
    );
    expect((await run(image({ id: 'd', mimeType: 'image/heic' }))).error).toContain('JPG');
    expect(tables.drive_folder_sync_files?.every((f) => f.attempts === 3)).toBe(true);
  });
});

describe('subcarpetas', () => {
  it('con la carpeta en la clave, mover el archivo cambia la clave de su fila, no la duplica', async () => {
    stubBody('FACTURA FE-1 Flores del Campo SAS, total cien mil pesos');
    const { db, tables } = fakeDb();
    const keyed = { ...invSync, key_fields: ['numero', 'carpeta'], sheet_mapping: {} };
    const extractor: DriveRowExtractor = async () => ({
      filas: [
        {
          campos: {
            numero: c('FE-1', 'FACTURA FE-1'),
            cliente: c('Flores', 'Flores'),
            total: c(null, null),
          },
        },
      ],
      observacion: null,
    });
    const gdoc = (path: string): FolderFile => ({
      id: 'doc-1',
      name: 'f.gdoc',
      mimeType: 'application/vnd.google-apps.document',
      revision: 'r1',
      modifiedTime: null,
      size: null,
      path,
    });
    await processDriveFile(db, drive, {
      sync: keyed,
      tracker: invTracker,
      file: gdoc('Cliente A'),
      extractor,
    });
    const row = tables.tracker_rows?.[0] as { id: string; external_key: string };
    expect(row.external_key).toBe('FE1 | CLIENTEA');
    const ledger = tables.drive_folder_sync_files?.[0] as {
      folder_path: string;
      tracker_row_ids: string[];
    };
    expect(ledger.folder_path).toBe('Cliente A');

    await processDriveFile(db, drive, {
      sync: keyed,
      tracker: invTracker,
      file: gdoc('Cliente B'),
      extractor,
      ledger: {
        file_id: 'doc-1',
        revision: 'r1',
        status: 'ok',
        attempts: 1,
        folder_path: ledger.folder_path,
        tracker_row_ids: [row.id],
      },
    });
    expect(tables.tracker_rows).toHaveLength(1);
    expect(row.external_key).toBe('FE1 | CLIENTEB');
  });
});

// ---------------------------------------------------------------------------
// Varios tipos de documento por fila y campos que salen de la ruta
// ---------------------------------------------------------------------------

describe('una carpeta organizada por mes y vuelo, con varios tipos de documento', () => {
  const vFields: TrackerField[] = [
    { key: 'guia', label: 'Guía', type: 'text', required: false },
    { key: 'piezas', label: 'Piezas', type: 'number', required: false },
    { key: 'kilos', label: 'Kilos', type: 'number', required: false },
    { key: 'vuelo', label: 'Vuelo', type: 'text', required: false },
    { key: 'fecha', label: 'Fecha del vuelo', type: 'date', required: false },
    preset.fields.find((f) => f.key === 'revision') as TrackerField,
  ];
  const vTracker = { id: 't3', slug: 'vlos', name: 'VLOS', description: '', fields: vFields };
  const PREALERTA = docTypeKey('PREALERTA 1.pdf', 'application/pdf');
  const MANIFIESTO = docTypeKey('MANIFIESTO AEROLINEAS.csv', 'text/csv');
  const vSync: DriveFolderSyncRow = {
    ...sync,
    id: 's3',
    tracker_id: 't3',
    extract_fields: [
      { key: 'guia', hint: '', docType: PREALERTA },
      { key: 'piezas', hint: '', docType: PREALERTA },
      { key: 'vuelo', hint: '', fromPath: { level: 2, part: 'codigo' } },
      { key: 'fecha', hint: '', fromPath: { level: 2, part: 'fecha' } },
    ],
    key_fields: ['guia'],
    defaults: {},
    sheet_mapping: { guia: 'GUIA', kilos: 'KILOS', '@tipos': MANIFIESTO },
    recursive: true,
  };
  const at = (name: string, mimeType: string, path: string, id: string): FolderFile => ({
    id,
    name,
    mimeType,
    revision: 'r1',
    modifiedTime: null,
    size: null,
    path,
  });
  const PATH = '10.OCTUBRE / 33. FEDEX 3325 07102026';
  const PRE_TEXT = 'PREALERTA FEDEX 3325\nGUIA 045-111\nPIEZAS 12';
  const extractor: DriveRowExtractor = async () => ({
    filas: [{ campos: { guia: c('045-111', 'GUIA 045-111'), piezas: c('12', 'PIEZAS 12') } }],
    observacion: null,
  });
  const run = (db: SupabaseClient, file: FolderFile, body: string) => {
    stubBody(body);
    parse.fn = async () => ({ text: body });
    return processDriveFile(db, drive, { sync: vSync, tracker: vTracker, file, extractor });
  };

  it('prealerta + manifiesto llenan la MISMA fila; la ruta pone vuelo y fecha; el formulario no se lee', async () => {
    const { db, tables } = fakeDb();
    const pre = await run(db, at('PREALERTA 33.pdf', 'application/pdf', PATH, 'a'), PRE_TEXT);
    expect(pre).toMatchObject({ status: 'ok', inserted: 1 });
    const man = await run(
      db,
      at('MANIFIESTO AEROLINEAS.csv', 'text/csv', PATH, 'b'),
      'GUIA,KILOS\n045-111,340.5\n045-222,10',
    );
    // La fila de la guía 045-111 se completa; la 045-222 es nueva.
    expect(man).toMatchObject({ inserted: 1, updated: 1 });
    const dian = vi.fn(async () => new Response('x'));
    vi.stubGlobal('fetch', dian);
    const form = await processDriveFile(db, drive, {
      sync: vSync,
      tracker: vTracker,
      file: at('FORMULARIO DIAN DESCARGUE 33.pdf', 'application/pdf', PATH, 'c'),
      extractor: neverModel,
    });
    expect(form.status).toBe('ok');
    expect(dian).not.toHaveBeenCalled();
    expect(tables.drive_folder_sync_files?.find((f) => f.file_id === 'c')).toMatchObject({
      status: 'ok',
    });

    const rows = (tables.tracker_rows ?? []) as Array<{ values: Row; external_key: string }>;
    expect(rows).toHaveLength(2);
    const uno = rows.find((r) => r.external_key === '045111');
    expect(uno?.values).toMatchObject({
      guia: '045-111',
      piezas: 12,
      kilos: 340.5,
      vuelo: '3325',
      fecha: '2026-10-07',
      revision: 'OK',
    });

    // Idempotente: releer los dos no duplica ni cambia nada.
    const again = await run(db, at('PREALERTA 33.pdf', 'application/pdf', PATH, 'a'), PRE_TEXT);
    expect(again).toMatchObject({ inserted: 0, updated: 0 });
    expect(tables.tracker_rows).toHaveLength(2);
  });

  it('un nombre de subcarpeta que no encaja deja el campo vacío y la fila por revisar', async () => {
    const { db, tables } = fakeDb();
    const res = await run(
      db,
      at('PREALERTA 9.pdf', 'application/pdf', '10.OCTUBRE / KALITTA 1176', 'k'),
      PRE_TEXT,
    );
    expect(res).toMatchObject({ inserted: 1, needsReview: 1 });
    const row = (tables.tracker_rows?.[0] as { values: Row }).values;
    expect(row.vuelo).toBe('1176');
    expect(row.fecha).toBeUndefined();
    expect(row.revision).toBe('Por revisar');
    expect(String((tables.drive_folder_sync_files?.[0] as Row).notes)).toContain('Fecha del vuelo');
  });
});
