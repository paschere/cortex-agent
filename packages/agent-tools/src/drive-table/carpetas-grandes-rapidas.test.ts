import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Una carpeta de Drive de miles de archivos (meses → vuelos → documentos) con
 * 50 ms de latencia por llamada, como en producción: el recorrido en paralelo,
 * el presupuesto de tiempo de la propuesta y la herramienta liviana de estructura.
 */

const LATENCY = 50;
const MONTHS = 8;
const FLIGHTS = 30;
const DOCS_PER_FLIGHT = 10;
const FOLDER = 'application/vnd.google-apps.folder';
const AIRLINES = ['FEDEX', 'UPS', 'AVIANCA', 'LATAM', 'DHL'];
const DOC_NAMES = [
  'MANIFIESTO AEROLINEAS',
  'PREALERTA',
  'FACTURA COMERCIAL',
  'PACKING LIST',
  'GUIA MASTER',
  'DUA',
  'CERTIFICADO ORIGEN',
  'SEGURO',
  'MANIFIESTO CARGA',
  'LISTA EMPAQUE',
];

type Item = { id: string; name: string; mimeType: string; modifiedTime?: string };
const tree = new Map<string, Item[]>();
const state = { inflight: 0, maxInflight: 0, calls: 0 };

function build() {
  tree.clear();
  const months: Item[] = [];
  for (let m = 1; m <= MONTHS; m++) {
    const mid = `m${m}`;
    months.push({
      id: mid,
      name: `${String(m).padStart(2, '0')}. OCTUBRE ${2026 - m}`,
      mimeType: FOLDER,
    });
    const flights: Item[] = [];
    for (let v = 1; v <= FLIGHTS; v++) {
      const fid = `${mid}-v${v}`;
      const day = String((v % 27) + 1).padStart(2, '0');
      flights.push({
        id: fid,
        name: `${v}. ${AIRLINES[v % AIRLINES.length]} ${3300 + v} ${day}102026`,
        mimeType: FOLDER,
      });
      tree.set(
        fid,
        Array.from({ length: DOCS_PER_FLIGHT }, (_, d) => ({
          id: `${fid}-d${d}`,
          name: `${DOC_NAMES[d]} ${v}${d}.pdf`,
          mimeType: 'application/pdf',
          modifiedTime: `2026-10-${String((d % 27) + 1).padStart(2, '0')}T10:00:00Z`,
        })),
      );
    }
    tree.set(mid, flights);
  }
  tree.set('root-folder-0000000001', months);
}

vi.mock('../gdrive/client', () => ({
  driveGet: vi.fn(async (_ctx: unknown, path: string, params: Record<string, string>) => {
    state.calls += 1;
    state.inflight += 1;
    state.maxInflight = Math.max(state.maxInflight, state.inflight);
    await new Promise((r) => setTimeout(r, LATENCY));
    state.inflight -= 1;
    if (path.startsWith('/files/'))
      return { id: 'root-folder-0000000001', name: 'VUELOS', mimeType: FOLDER };
    const id = /'([^']+)' in parents/.exec(params.q ?? '')?.[1] ?? '';
    if (!tree.has(id)) throw new Error('403');
    return { files: tree.get(id) };
  }),
  driveGetBytes: vi.fn(),
  driveGetText: vi.fn(),
}));

import { gdriveFolderTree, summarizeTree } from './folder-tree';
import { INVENTORY_CONCURRENCY, listFolderTree } from './inventory';
import type { DocProposal } from './propose-folder';
import { proposeFromDriveFolder } from './propose-folder';

const drive = { integrations: {} as never, signal: undefined };
const ROOT = 'root-folder-0000000001';
const TOTAL_FILES = MONTHS * FLIGHTS * DOCS_PER_FLIGHT;
const TOTAL_FOLDERS = 1 + MONTHS + MONTHS * FLIGHTS;

beforeEach(() => {
  build();
  state.inflight = 0;
  state.maxInflight = 0;
  state.calls = 0;
});

describe('recorrido en paralelo', () => {
  it('lista miles de archivos mucho más rápido que en serie y sin pasar el tope de concurrencia', async () => {
    const t0 = Date.now();
    const out = await listFolderTree(drive, ROOT, { recursive: true, light: true });
    const ms = Date.now() - t0;
    expect(out.seen).toBe(TOTAL_FILES);
    expect(out.folders).toHaveLength(MONTHS + MONTHS * FLIGHTS);
    expect(state.calls).toBe(TOTAL_FOLDERS);
    expect(state.maxInflight).toBeLessThanOrEqual(INVENTORY_CONCURRENCY);
    expect(state.maxInflight).toBeGreaterThan(1);
    // En serie serían TOTAL_FOLDERS × 50 ms; con 8 en vuelo, ~1/8 (más holgura).
    const serial = TOTAL_FOLDERS * LATENCY;
    expect(ms).toBeLessThan(serial / 4);
    console.info(
      `listado: ${ms} ms en paralelo vs ~${serial} ms en serie (${TOTAL_FILES} archivos)`,
    );
  }, 20_000);

  it('es determinista: dos corridas dan el mismo árbol, en el mismo orden', async () => {
    const a = await listFolderTree(drive, ROOT, { recursive: true, light: true, concurrency: 8 });
    const b = await listFolderTree(drive, ROOT, { recursive: true, light: true, concurrency: 3 });
    expect(b.files.map((f) => f.id)).toEqual(a.files.map((f) => f.id));
    expect(b.folders.map((f) => f.path)).toEqual(a.folders.map((f) => f.path));
  }, 20_000);

  it('pasada la fecha límite deja de abrir carpetas y lo dice', async () => {
    const t0 = Date.now();
    const out = await listFolderTree(drive, ROOT, {
      recursive: true,
      light: true,
      deadline: Date.now() + 300,
    });
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(out.timedOut).toBe(true);
    expect(out.truncated).toBe(true);
    expect(out.foldersLeft ?? 0).toBeGreaterThan(0);
    expect(out.seen ?? 0).toBeLessThan(TOTAL_FILES);
  }, 20_000);

  it('el modo liviano no pide lo que no usa', async () => {
    const { driveGet } = await import('../gdrive/client');
    (driveGet as ReturnType<typeof vi.fn>).mockClear();
    await listFolderTree(drive, 'm1', { recursive: true, light: true });
    const params = (driveGet as ReturnType<typeof vi.fn>).mock.calls[0]?.[2] as Record<
      string,
      string
    >;
    expect(params.fields).not.toContain('md5Checksum');
    expect(params.orderBy).toBeUndefined();
    expect(params.pageSize).toBe('1000');
  });
});

describe('proposeFromDriveFolder con presupuesto', () => {
  const doc = (label: string): DocProposal => ({
    name: label,
    description: '',
    fields: [{ key: 'numero', label: 'Número', type: 'text', required: false }],
    extract: [{ key: 'numero', hint: '' }],
    keyFields: ['numero'],
    sampleName: `${label}.pdf`,
  });

  it('lee los tipos de a 3 a la vez y avisa el avance', async () => {
    let live = 0;
    let max = 0;
    const lines: string[] = [];
    const p = await proposeFromDriveFolder(
      drive,
      { id: ROOT, name: 'VUELOS' },
      { onProgress: (l) => lines.push(l) },
      {
        proposeDocs: async (_files, o) => {
          live += 1;
          max = Math.max(max, live);
          await new Promise((r) => setTimeout(r, 200));
          live -= 1;
          return doc(o.typeLabel ?? 'x');
        },
      },
    );
    expect(max).toBe(3);
    expect(p.types.length).toBeGreaterThan(3);
    expect(lines.some((l) => l.startsWith('Listé'))).toBe(true);
    expect(lines.some((l) => l.startsWith('Leyendo una muestra'))).toBe(true);
    expect(p.pathPatterns.length).toBeGreaterThan(0);
  }, 30_000);

  it('al agotarse el presupuesto propone con lo leído y dice cuánto cubrió', async () => {
    const t0 = Date.now();
    const p = await proposeFromDriveFolder(
      drive,
      { id: ROOT, name: 'VUELOS' },
      { budgetMs: 3000 },
      {
        // Cada muestra tarda más que lo que queda: sólo alcanzan las primeras.
        proposeDocs: async (_files, o) => {
          await new Promise((r) => setTimeout(r, 700));
          return doc(o.typeLabel ?? 'x');
        },
      },
    );
    expect(Date.now() - t0).toBeLessThan(5000);
    const joined = p.notes.join('\n');
    expect(joined).toMatch(
      /Se acabó el tiempo del recorrido: revisé [\d.]+ de unos [\d.]+ archivos/,
    );
    expect(p.inventory.estimated).toBe(true);
    expect(p.inventory.total).toBeLessThan(TOTAL_FILES);
    expect(joined).toMatch(/Se acabó el tiempo \(3 s\) antes de leer una muestra de/);
    expect(p.markdown).toContain('Se acabó el tiempo');
  }, 30_000);
});

describe('gdrive.folder_tree', () => {
  it('devuelve la estructura por nivel con los patrones de nombre, en pocos segundos', async () => {
    const t0 = Date.now();
    const lines: string[] = [];
    const out = await gdriveFolderTree.handler(
      {
        folder: 'https://drive.google.com/drive/folders/root-folder-0000000001',
        depth: 3,
        includeFiles: true,
      },
      { integrations: {} as never, onProgress: (l: string) => lines.push(l) } as never,
    );
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(out.totalFolders).toBe(MONTHS + MONTHS * FLIGHTS);
    expect(out.totalFiles).toBe(TOTAL_FILES);
    expect(out.timedOut).toBe(false);
    const flights = (
      out.levels as Array<{
        level: number;
        folders: number;
        pattern?: { shape: string };
        files: { total: number };
      }>
    ).find((l) => l.level === 2);
    expect(flights?.folders).toBe(MONTHS * FLIGHTS);
    expect(flights?.pattern?.shape).toBe('n.º + nombre + código + fecha');
    expect(flights?.files.total).toBe(TOTAL_FILES);
    expect(out.markdown).toMatch(/lista empaque/i);
    expect(out.markdown).toContain('→ n.º');
    expect(lines.length).toBeGreaterThan(0);
  }, 20_000);

  it('sin includeFiles sólo cuenta carpetas y su resumen es determinista', async () => {
    const t = await listFolderTree(drive, ROOT, { recursive: true, maxDepth: 2, light: true });
    const a = summarizeTree(t, 'VUELOS', { includeFiles: false, depth: 2 });
    const b = summarizeTree(t, 'VUELOS', { includeFiles: false, depth: 2 });
    expect(a).toEqual(b);
    expect(a.levels.every((l) => l.files === undefined)).toBe(true);
    expect(a.markdown).not.toContain('Archivos directamente');
  }, 20_000);
});
