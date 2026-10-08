import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { readXlsxMinimal } from '../accounting/providers/spreadsheet-bytes';
import { XLSX_MIME, parseSpreadsheet } from '../kb/spreadsheets';
import { docTypeKey, groupByDocType, matchDocType } from './doc-types';
import { type FolderTree, inventoryMarkdown, inventoryOf, stratifiedSample } from './inventory';
import { describeValues, detectPathPatterns, parseSegment, pathValue } from './path-fields';
import { REVIEW_FIELD } from './plan';
import type { FolderFile } from './plan';
import { type DocProposal, combineFolderProposal } from './propose-folder';
import { pathFieldValues, routeFile, syncConfigOf } from './sync-config';

/**
 * La carpeta de una operación por lotes: un mes por carpeta, una subcarpeta por
 * vuelo («33. FEDEX 3325 07102026»), y dentro varios tipos de documento. Todo
 * simulado: sin Drive ni modelo.
 */

const PDF = 'application/pdf';
const MONTHS = ['09.SEPTIEMBRE', '10.OCTUBRE'];
const AIRLINES = ['FEDEX 3325', 'KALITTA 1176', 'AMERIJET 9294', 'UPS 5521', 'DHL 7788'];

function carpetaDeVuelos(vuelosPorMes: number) {
  const files: FolderFile[] = [];
  const folders: FolderTree['folders'] = [];
  let n = 0;
  for (const [mi, month] of MONTHS.entries()) {
    folders.push({ id: `m${mi}`, name: month, path: month, depth: 1, files: 0 });
    for (let v = 1; v <= vuelosPorMes; v++) {
      const air = AIRLINES[v % AIRLINES.length] as string;
      // Algunas subcarpetas no traen fecha ni consecutivo.
      const name =
        v % 10 === 0
          ? `${air.split(' ')[0]} ${1000 + v}`
          : `${v}. ${air} ${String(1 + (v % 28)).padStart(2, '0')}${mi === 0 ? '09' : '10'}2026`;
      const path = `${month} / ${name}`;
      folders.push({ id: `f${mi}-${v}`, name, path, depth: 2, files: 3 });
      const mk = (file: string, mime: string, seq = ''): FolderFile => ({
        id: `${mi}-${v}-${file}${seq}`,
        name: file,
        mimeType: mime,
        revision: 'r',
        modifiedTime: `2026-10-${String((n++ % 28) + 1).padStart(2, '0')}T00:00:00Z`,
        size: 1000,
        path,
      });
      files.push(mk(`PREALERTA ${v}.pdf`, PDF));
      files.push(mk('MANIFIESTO AEROLINEAS.xlsx', XLSX_MIME));
      files.push(mk(`FORMULARIO DIAN DESCARGUE ${v}.pdf`, PDF));
      if (v % 7 === 0) files.push(mk(`foto ${v}.jpg`, 'image/jpeg'));
    }
  }
  return { files, folders };
}
const tree = (
  files: FolderFile[],
  folders: FolderTree['folders'],
  extra: Partial<FolderTree> = {},
): FolderTree => ({
  files,
  folders,
  truncated: false,
  tooDeep: [],
  skipped: [],
  problems: [],
  ...extra,
});

describe('nombres de subcarpetas', () => {
  it('saca secuencia, texto, código y fecha de los nombres reales; lo que no trae queda sin valor', () => {
    expect(parseSegment('33. FEDEX 3325 07102026')).toEqual({
      secuencia: 33,
      texto: 'FEDEX',
      codigo: '3325',
      fecha: '2026-10-07',
    });
    expect(describeValues(parseSegment('33. FEDEX 3325 07102026'))).toBe(
      'n.º 33, nombre FEDEX, código 3325, fecha 2026-10-07',
    );
    expect(parseSegment('25.AMERIJET 9294 06102026')).toMatchObject({
      secuencia: 25,
      texto: 'AMERIJET',
      codigo: '9294',
      fecha: '2026-10-06',
    });
    // Sin consecutivo ni fecha: no se inventan.
    const kalitta = parseSegment('KALITTA 1176');
    expect(kalitta).toEqual({ texto: 'KALITTA', codigo: '1176' });
    expect(kalitta.fecha).toBeUndefined();
    expect(parseSegment('10.OCTUBRE')).toMatchObject({ secuencia: 10, mes: 10 });
    expect(parseSegment('09.SEPTIEMBRE').mes).toBe(9);
  });

  it('entiende varios formatos de fecha y rechaza fechas imposibles', () => {
    expect(parseSegment('UPS 5521 20261007').fecha).toBe('2026-10-07');
    expect(parseSegment('UPS 5521 07-10-2026').fecha).toBe('2026-10-07');
    expect(parseSegment('UPS 5521 2026-10-07').fecha).toBe('2026-10-07');
    expect(parseSegment('UPS 5521 07/10/2026').fecha).toBe('2026-10-07');
    expect(parseSegment('UPS 5521 31022026').fecha).toBeUndefined();
    expect(parseSegment('UPS 5521 99999999').fecha).toBeUndefined();
  });

  it('detecta el patrón por nivel, con ejemplos y los nombres que no encajan', () => {
    const { folders } = carpetaDeVuelos(20);
    const patterns = detectPathPatterns(folders);
    expect(patterns.map((p) => p.level)).toEqual([1, 2]);
    expect(patterns[0]?.parts).toEqual(['mes']);
    const vuelos = patterns[1];
    expect(vuelos?.parts).toEqual(['secuencia', 'texto', 'codigo', 'fecha']);
    expect(vuelos?.examples).toHaveLength(3);
    expect(vuelos?.matching).toBeLessThan(vuelos?.names ?? 0);
    expect(vuelos?.unmatched.some((n) => !/\d{6}/.test(n))).toBe(true);
  });

  it('pathValue toma la pieza del nivel pedido y es vacío si el nombre no la trae', () => {
    const path = '10.OCTUBRE / 33. FEDEX 3325 07102026';
    expect(pathValue(path, { level: 2, part: 'fecha' })).toBe('2026-10-07');
    expect(pathValue(path, { level: 1, part: 'mes' })).toBe(10);
    expect(pathValue('10.OCTUBRE / KALITTA 1176', { level: 2, part: 'fecha' })).toBeUndefined();
    expect(pathValue('10.OCTUBRE', { level: 2, part: 'texto' })).toBeUndefined();
  });
});

describe('tipos de documento', () => {
  it('agrupa por nombre sin números ni fechas y por extensión', () => {
    expect(docTypeKey('PREALERTA 3325.pdf', PDF)).toBe(docTypeKey('prealerta 9999 (1).PDF', PDF));
    expect(docTypeKey('MANIFIESTO AEROLINEAS.xlsx', XLSX_MIME)).not.toBe(
      docTypeKey('MANIFIESTO AEROLINEAS.pdf', PDF),
    );
    const { files } = carpetaDeVuelos(30);
    const groups = groupByDocType(files);
    const by = (s: string) => groups.find((g) => g.label.startsWith(s));
    expect(by('prealerta')?.count).toBe(60);
    expect(by('manifiesto')?.count).toBe(60);
    expect(by('formulario dian')?.count).toBe(60);
    expect(by('foto')?.count).toBeGreaterThan(0);
    expect(by('prealerta')?.folders).toBe(60);
    expect(by('prealerta')?.examples).toHaveLength(3);
  });

  it('un archivo se reconoce con el tipo de la sincronización aunque el nombre varíe un poco', () => {
    const key = docTypeKey('MANIFIESTO AEROLINEAS.xlsx', XLSX_MIME);
    expect(matchDocType('MANIFIESTO AEROLINEAS FEDEX.xlsx', XLSX_MIME, [key])).toBe(key);
    expect(matchDocType('PREALERTA 1.pdf', PDF, [key])).toBeNull();
  });
});

describe('inventario sin techo ciego', () => {
  it('con más archivos que el tope toma una muestra estratificada y dice el conteo real', () => {
    const { files, folders } = carpetaDeVuelos(450); // ~2.800 archivos
    expect(files.length).toBeGreaterThan(2500);
    const inv = inventoryOf(tree(files, folders), { recursive: true, maxDepth: 4, maxFiles: 500 });
    expect(inv.sampled).toBe(true);
    expect(inv.sampleSize).toBe(500);
    expect(inv.total).toBe(files.length);
    expect(inv.estimatedTotal).toBe(files.length);
    // Los conteos son de TODOS; las listas, de la muestra.
    expect(inv.counts.sheet).toBe(900);
    expect(inv.sheets.length + inv.documents.length + inv.images.length).toBe(500);
    // La muestra representa: ambos meses y todos los tipos.
    const inSample = [...inv.sheets, ...inv.documents, ...inv.images];
    for (const m of MONTHS) expect(inSample.some((f) => f.path?.startsWith(m))).toBe(true);
    const tipos = new Set(inSample.map((f) => docTypeKey(f.name, f.mimeType).split(/[ .]/)[0]));
    expect(tipos).toEqual(new Set(['prealerta', 'manifiesto', 'formulario', 'foto']));
    const md = inventoryMarkdown(inv, 'VLOS 2026');
    expect(md).toContain('MUESTRA representativa');
    expect(md).toContain('La sincronización sí lee todos');
  });

  it('es determinista y no pasa de n', () => {
    const { files } = carpetaDeVuelos(300);
    const a = stratifiedSample(files, 400);
    const b = stratifiedSample(files, 400);
    expect(a.sample.map((f) => f.id)).toEqual(b.sample.map((f) => f.id));
    expect(a.sample).toHaveLength(400);
    expect(a.strata).toBeGreaterThanOrEqual(4);
  });

  it('si el recorrido se cortó, la cifra es un estimado y se avisa', () => {
    const { files, folders } = carpetaDeVuelos(20);
    const inv = inventoryOf(
      tree(files.slice(0, 50), folders, { truncated: true, seen: 4000, foldersLeft: 0 }),
      { recursive: true, maxDepth: 4, maxFiles: 5000 },
    );
    expect(inv.estimated).toBe(true);
    expect(inv.estimatedTotal).toBe(4000);
    expect(inventoryMarkdown(inv, 'VLOS')).toContain('más de 4.000');
  });
});

describe('hojas grandes', () => {
  async function bigXlsx(rows: number, cols: number): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('MANIFIESTO');
    ws.addRow(Array.from({ length: cols }, (_, i) => `COL${i + 1}`));
    for (let r = 1; r <= rows; r++) ws.addRow(Array.from({ length: cols }, (_, i) => r * 100 + i));
    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  it('sin opciones sigue rechazando las de más de 50.000 celdas; con rowLimit lee el comienzo', async () => {
    const bytes = await bigXlsx(2500, 30); // 75.000 celdas
    await expect(parseSpreadsheet(bytes, XLSX_MIME)).rejects.toThrow(/50\.000/);
    const [sheet] = await parseSpreadsheet(bytes, XLSX_MIME, { rowLimit: 301 });
    expect(sheet?.rows).toHaveLength(301);
    expect(sheet?.rows[0]?.[0]).toBe('COL1');
    expect(sheet?.truncated).toBe(true);
    expect(sheet?.totalRows).toBe(2501);
    const [all] = await parseSpreadsheet(bytes, XLSX_MIME, { rowLimit: 5000 });
    expect(all?.rows).toHaveLength(2501);
    expect(all?.truncated).toBe(false);
  });

  it('el lector mínimo también se queda con las primeras filas en vez de descartar la hoja', async () => {
    const bytes = await bigXlsx(500, 10);
    const [sheet] = await readXlsxMinimal(bytes, { maxRows: 50 });
    expect(sheet?.rows).toHaveLength(50);
    expect(sheet?.rows[0]?.[0]).toBe('COL1');
  });
});

describe('la propuesta con varios tipos de documento', () => {
  const folder = { id: 'root', name: 'VLOS 2026' };
  const { files, folders } = carpetaDeVuelos(40);
  const inventory = inventoryOf(tree(files, folders), {
    recursive: true,
    maxDepth: 4,
    maxFiles: 5000,
  });
  const groups = groupByDocType(files);
  const g = (s: string) => groups.find((x) => x.label.startsWith(s)) as (typeof groups)[number];
  const proposal = (over: Partial<DocProposal>): DocProposal => ({
    name: 'Vuelos',
    description: 'Carga por vuelo',
    fields: [
      { key: 'guia', label: 'Guía', type: 'text', required: false },
      { key: 'piezas', label: 'Piezas', type: 'number', required: false },
      REVIEW_FIELD,
    ],
    extract: [
      { key: 'guia', hint: 'arriba' },
      { key: 'piezas', hint: 'casilla 5' },
    ],
    keyFields: ['guia'],
    sampleName: 'PREALERTA 1.pdf',
    role: 'base',
    ...over,
  });
  const docs = [
    { group: g('prealerta'), proposal: proposal({}) },
    {
      group: g('formulario dian'),
      proposal: proposal({
        fields: [{ key: 'nit', label: 'NIT', type: 'text', required: false }, REVIEW_FIELD],
        extract: [{ key: 'nit', hint: '' }],
        keyFields: ['nit'],
        sampleName: 'FORMULARIO DIAN DESCARGUE 1.pdf',
        role: 'no_sirve',
        roleWhy: 'no trae guía, piezas ni kilos',
      }),
    },
  ];

  it('muestra los tipos con conteo, descarta el que no sirve y propone campos de la ruta', () => {
    const p = combineFolderProposal({
      folder,
      recursive: true,
      inventory,
      sheets: [],
      doc: null,
      docs,
      goal: 'guía, piezas y kilos',
    });
    const fieldOf = (k: string) => p.fields.find((f) => f.key === k);
    // El formulario DIAN no aporta campos ni se lee.
    expect(fieldOf('nit')).toBeUndefined();
    expect(fieldOf('guia')?.docTypes?.map((d) => d.type)).toEqual([g('prealerta').key]);
    expect(p.types.find((t) => t.label.startsWith('formulario dian'))).toMatchObject({
      role: 'no_sirve',
      count: 80,
    });
    expect(p.markdown).toContain('Tipos de documento que hay en la carpeta');
    expect(p.markdown).toContain('no sirve para lo pedido');
    // Campos de la ruta: nivel, pieza y 3 ejemplos reales en la nota.
    expect(fieldOf('fecha_carpeta')?.fromPath).toEqual({ level: 2, part: 'fecha' });
    expect(fieldOf('codigo_carpeta')?.fromPath).toEqual({ level: 2, part: 'codigo' });
    expect(fieldOf('mes')?.fromPath).toEqual({ level: 1, part: 'mes' });
    expect(p.markdown).toMatch(/→ n\.º \d+, nombre \w+, código \d+, fecha 2026-\d\d-\d\d/);
    expect(p.markdown).toContain('No encajan');
    // Con `goal` no hay pregunta.
    expect(p.ask).toBeNull();
  });

  it('sin goal y con dos tipos que cuentan pregunta con opciones cortas en vez de adivinar', () => {
    const both = [
      docs[0] as (typeof docs)[0],
      {
        group: g('formulario dian'),
        proposal: proposal({
          fields: [
            { key: 'guia', label: 'Guía', type: 'text', required: false },
            { key: 'kilos', label: 'Kilos', type: 'number', required: false },
            REVIEW_FIELD,
          ],
          extract: [
            { key: 'guia', hint: '' },
            { key: 'kilos', hint: '' },
          ],
          role: 'complementario',
          sampleName: 'FORMULARIO DIAN DESCARGUE 1.pdf',
        }),
      },
    ];
    const p = combineFolderProposal({
      folder,
      recursive: true,
      inventory,
      sheets: [],
      doc: null,
      docs: both,
    });
    expect(p.ask).not.toBeNull();
    expect(p.ask?.question.length).toBeLessThanOrEqual(180);
    expect(p.ask?.options.length).toBeGreaterThanOrEqual(2);
    expect(p.ask?.options.length).toBeLessThanOrEqual(5);
    for (const o of p.ask?.options ?? []) expect(o.length).toBeLessThanOrEqual(64);
    expect(p.markdown).toContain('ask_choice');
    // Los dos tipos llenan campos distintos de la misma fila, unidos por la guía.
    expect(p.keyFields).toEqual(['guia']);
    expect(p.fields.find((f) => f.key === 'guia')?.docTypes).toHaveLength(2);
    expect(p.fields.find((f) => f.key === 'kilos')?.docTypes).toHaveLength(1);
  });
});

describe('qué se hace con cada archivo en la sincronización', () => {
  const prealerta = docTypeKey('PREALERTA 1.pdf', PDF);
  const manifiesto = docTypeKey('MANIFIESTO AEROLINEAS.xlsx', XLSX_MIME);
  const cfg = syncConfigOf({
    extract_fields: [
      { key: 'guia', hint: '', docType: prealerta },
      { key: 'piezas', hint: '', docType: prealerta },
      { key: 'vuelo', hint: '', fromPath: { level: 2, part: 'codigo' } },
      { key: 'fecha', hint: '', fromPath: { level: 2, part: 'fecha' } },
    ],
    sheet_mapping: { guia: 'GUIA', kilos: 'KILOS', '@tipos': manifiesto },
  });
  const keys = new Set(['guia', 'piezas', 'kilos', 'vuelo', 'fecha']);

  it('la prealerta se lee con el modelo, el manifiesto como hoja, el formulario se salta', () => {
    expect(cfg.byType).toBe(true);
    expect(routeFile(cfg, { name: 'PREALERTA 7.pdf', mimeType: PDF }, false, keys)).toMatchObject({
      kind: 'read',
      sheet: false,
      extract: [{ key: 'guia' }, { key: 'piezas' }],
    });
    expect(
      routeFile(cfg, { name: 'MANIFIESTO AEROLINEAS.xlsx', mimeType: XLSX_MIME }, true, keys),
    ).toMatchObject({ kind: 'read', sheet: true });
    expect(
      routeFile(cfg, { name: 'FORMULARIO DIAN DESCARGUE 7.pdf', mimeType: PDF }, false, keys).kind,
    ).toBe('skip');
    // Una hoja de OTRO tipo no se lee con el mapeo del manifiesto.
    expect(routeFile(cfg, { name: 'INVENTARIO.xlsx', mimeType: XLSX_MIME }, true, keys).kind).toBe(
      'skip',
    );
  });

  it('los campos de la ruta se llenan; lo que el nombre no trae queda vacío y por revisar', () => {
    const fields = [
      { key: 'vuelo', label: 'Vuelo', type: 'text' as const, required: false },
      { key: 'fecha', label: 'Fecha', type: 'date' as const, required: false },
    ];
    const ok = pathFieldValues(cfg, '10.OCTUBRE / 33. FEDEX 3325 07102026', fields);
    expect(ok.values).toEqual({ vuelo: '3325', fecha: '2026-10-07' });
    expect(ok.review).toEqual([]);
    const sinFecha = pathFieldValues(cfg, '10.OCTUBRE / KALITTA 1176', fields);
    expect(sinFecha.values).toEqual({ vuelo: '1176' });
    expect(sinFecha.review.join(' ')).toContain('«Fecha»');
    expect(sinFecha.review.join(' ')).toContain('KALITTA 1176');
    const suelto = pathFieldValues(cfg, '10.OCTUBRE', fields);
    expect(suelto.values).toEqual({});
    expect(suelto.review).toHaveLength(2);
  });
});
