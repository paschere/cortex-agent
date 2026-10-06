import { beforeEach, describe, expect, it, vi } from 'vitest';
import { XLSX_MIME } from '../kb/spreadsheets';

type Item = {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
  shortcutDetails?: { targetId: string; targetMimeType: string };
};
const tree = new Map<string, Item[]>();
const asked: string[] = [];

vi.mock('../gdrive/client', () => ({
  driveGet: vi.fn(async (_ctx: unknown, _path: string, params: Record<string, string>) => {
    const id = /'([^']+)' in parents/.exec(params.q ?? '')?.[1] ?? '';
    asked.push(id);
    if (!tree.has(id)) throw new Error('403');
    return { files: tree.get(id) };
  }),
  driveGetBytes: vi.fn(),
  driveGetText: vi.fn(),
}));

import { inventoryFolder, inventoryMarkdown } from './inventory';

const FOLDER = 'application/vnd.google-apps.folder';
const SHORTCUT = 'application/vnd.google-apps.shortcut';
const drive = { integrations: {} as never, signal: undefined };
const file = (id: string, name: string, mimeType: string): Item => ({ id, name, mimeType });

beforeEach(() => {
  tree.clear();
  asked.length = 0;
  tree.set('root', [
    file('s1', 'ventas.xlsx', XLSX_MIME),
    file('d1', 'contrato.pdf', 'application/pdf'),
    file('i1', 'foto.jpg', 'image/jpeg'),
    file('x1', 'viejo.xls', 'application/vnd.ms-excel'),
    file('h1', 'iphone.heic', 'image/heic'),
    file('A', 'Cliente A', FOLDER),
    file('B', 'Cliente B', FOLDER),
  ]);
  tree.set('A', [file('s2', 'oct.csv', 'text/csv'), file('A1', 'Octubre', FOLDER)]);
  tree.set('A1', [
    file(
      'd2',
      'acta.docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ),
    file('A2', 'Detalle', FOLDER),
  ]);
  tree.set('A2', [file('A3', 'Muy hondo', FOLDER), file('s3', 'hondo.csv', 'text/csv')]);
  tree.set('A3', [file('z', 'nunca.csv', 'text/csv')]);
  tree.set('B', [
    // un atajo que apunta a la raíz: no hace bucle
    {
      id: 'sc1',
      name: 'atajo a raíz',
      mimeType: SHORTCUT,
      shortcutDetails: { targetId: 'root', targetMimeType: FOLDER },
    },
    // un atajo a un archivo es ese archivo
    {
      id: 'sc2',
      name: 'atajo a hoja',
      mimeType: SHORTCUT,
      shortcutDetails: { targetId: 's1', targetMimeType: XLSX_MIME },
    },
    file('d3', 'otra.pdf', 'application/pdf'),
  ]);
});

describe('inventario de una carpeta', () => {
  it('sin recursivo: cuenta la raíz por clase y nombra lo que no se incluyó', async () => {
    const inv = await inventoryFolder(drive, 'root');
    expect(inv.counts).toEqual({ sheet: 1, document: 1, image: 1, unreadable: 2 });
    expect(inv.skipped).toEqual(['Cliente A', 'Cliente B']);
    expect(inv.folders).toEqual([]);
    expect(inv.unreadable.map((u) => u.reason).join(' ')).toMatch(
      /\.xls.*HEIC|HEIC.*\.xls|Excel antiguo/,
    );
    expect(inventoryMarkdown(inv, 'Raíz')).toContain('NO incluí');
  });

  it('recursivo: baja por niveles hasta maxDepth, con rutas, sin seguir atajos en bucle', async () => {
    const inv = await inventoryFolder(drive, 'root', { recursive: true, maxDepth: 3 });
    expect(inv.folders.map((f) => f.path).sort()).toEqual([
      'Cliente A',
      'Cliente A / Octubre',
      'Cliente A / Octubre / Detalle',
      'Cliente B',
    ]);
    // «Muy hondo» queda en el nivel 4: no se abre y se dice.
    expect(inv.tooDeep).toEqual(['Cliente A / Octubre / Detalle / Muy hondo']);
    expect(asked).not.toContain('A3');
    // El atajo a la raíz no la vuelve a abrir; el atajo a la hoja no la cuenta dos veces.
    expect(asked.filter((id) => id === 'root')).toHaveLength(1);
    expect(inv.counts.sheet).toBe(3); // ventas (una sola vez, aunque haya un atajo), oct, hondo
    const paths = new Set(inv.sheets.map((f) => f.path));
    expect(paths.has('Cliente A')).toBe(true);
    expect(inv.documents.find((d) => d.id === 'd2')?.path).toBe('Cliente A / Octubre');
  });

  it('para en maxFiles y avisa', async () => {
    const inv = await inventoryFolder(drive, 'root', { recursive: true, maxFiles: 4 });
    expect(inv.total).toBe(4);
    expect(inv.truncated).toBe(true);
    expect(inventoryMarkdown(inv, 'Raíz')).toContain('primeros 4');
  });

  it('una subcarpeta sin acceso se anota y no tumba el inventario; la raíz sí propaga', async () => {
    tree.delete('B');
    const inv = await inventoryFolder(drive, 'root', { recursive: true });
    expect(inv.problems).toEqual(['Cliente B']);
    await expect(inventoryFolder(drive, 'nada')).rejects.toThrow('403');
  });
});
