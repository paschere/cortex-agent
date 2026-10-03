/**
 * PRODUCTOS DESDE UNA HOJA O UN CSV (migración 0183). Puro.
 *
 * La hoja de inventario de una pyme no tiene un formato: «Código», «Ref.»,
 * «SKU»; «Existencias», «Saldo», «Cantidad»; «$ 12.500» o «12500,5». Aquí se
 * reconoce cada columna por su encabezado (sin tildes ni mayúsculas) y se lee
 * cada número en la forma colombiana. Una fila sin nombre ni código se salta y
 * se cuenta; nada se adivina.
 */

export interface SheetProductDraft {
  /** Fila de la hoja (1 = la primera de datos), para los mensajes. */
  row: number;
  sku: string | null;
  name: string;
  unit: string | null;
  category: string | null;
  cost: number | null;
  price: number | null;
  /** Existencia contada en la hoja: entra como ajuste por la diferencia. */
  stock: number | null;
  minStock: number | null;
  reorderQty: number | null;
  leadTimeDays: number | null;
  supplierName: string | null;
  supplierTaxId: string | null;
  location: string | null;
}

export interface SheetParseResult {
  drafts: SheetProductDraft[];
  skipped: Array<{ row: number; reason: string }>;
  /** Columnas reconocidas: clave → encabezado original. */
  recognized: Record<string, string>;
  /** Encabezados que no se usaron. */
  ignored: string[];
}

type Field = Exclude<keyof SheetProductDraft, 'row'>;

const ALIASES: Record<Field, string[]> = {
  sku: ['sku', 'codigo', 'cod', 'referencia', 'ref', 'codigo producto', 'item', 'codigo de barras'],
  name: ['nombre', 'producto', 'descripcion', 'articulo', 'nombre producto', 'name', 'item name'],
  unit: ['unidad', 'und', 'unidad de medida', 'um', 'unit'],
  category: ['categoria', 'grupo', 'linea', 'familia', 'category'],
  cost: ['costo', 'costo unitario', 'costo promedio', 'valor unitario', 'cost', 'unit cost'],
  price: ['precio', 'precio de venta', 'precio venta', 'pvp', 'price'],
  stock: [
    'existencias',
    'existencia',
    'stock',
    'cantidad',
    'saldo',
    'inventario',
    'disponible',
    'qty',
    'on hand',
  ],
  minStock: ['minimo', 'stock minimo', 'existencia minima', 'cantidad minima', 'min', 'min stock'],
  reorderQty: [
    'reorden',
    'cantidad a pedir',
    'pedido',
    'cantidad de reposicion',
    'reposicion',
    'reorder qty',
  ],
  leadTimeDays: [
    'tiempo de entrega',
    'dias de entrega',
    'lead time',
    'dias entrega',
    'entrega dias',
  ],
  supplierName: ['proveedor', 'proveedor habitual', 'supplier', 'vendor'],
  supplierTaxId: ['nit proveedor', 'nit', 'nit del proveedor'],
  location: ['bodega', 'almacen', 'ubicacion', 'sede', 'warehouse'],
};

export function headerKey(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * «$ 12.500» → 12500; «1.234,5» → 1234.5; «1,234.50» → 1234.5; «12,5» → 12.5;
 * «1.500» → 1500 (punto de miles colombiano). Vacío o basura → null.
 */
export function parseNumberCo(raw: string | null | undefined): number | null {
  let s = (raw ?? '').trim().replace(/[$\s]|COP|und/gi, '');
  if (!s) return null;
  const negative = /^-|^\(.*\)$/.test(s);
  s = s.replace(/[()-]/g, '');
  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  if (lastDot >= 0 && lastComma >= 0) {
    // El separador que va de último es el decimal.
    s = lastComma > lastDot ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  } else if (lastComma >= 0) {
    const parts = s.split(',');
    // «1,234,567» (miles) frente a «12,5» (decimal).
    s = parts.length > 2 || parts[1]?.length === 3 ? s.replace(/,/g, '') : s.replace(',', '.');
  } else if (lastDot >= 0) {
    const parts = s.split('.');
    if (parts.length > 2 || parts[1]?.length === 3) s = s.replace(/\./g, '');
  }
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? (negative ? -n : n) : null;
}

/** CSV con comillas, coma o punto y coma (Excel en español exporta con «;»). */
export function parseCsv(text: string): string[][] {
  const clean = text.replace(/^﻿/, '');
  const firstLine = clean.split(/\r?\n/, 1)[0] ?? '';
  const delimiter =
    (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0)
      ? ';'
      : firstLine.includes('\t')
        ? '\t'
        : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (quoted) {
      if (ch === '"' && clean[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === delimiter) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && clean[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

const TEXT_FIELDS = new Set<Field>([
  'sku',
  'name',
  'unit',
  'category',
  'supplierName',
  'supplierTaxId',
  'location',
]);

/** Filas (la primera = encabezados) → borradores de producto. */
export function parseProductSheet(rows: readonly string[][]): SheetParseResult {
  const [header, ...data] = rows;
  const recognized: Record<string, string> = {};
  const ignored: string[] = [];
  const columnOf = new Map<Field, number>();
  (header ?? []).forEach((h, i) => {
    const key = headerKey(h);
    const field = (Object.keys(ALIASES) as Field[]).find(
      (f) => !columnOf.has(f) && ALIASES[f].includes(key),
    );
    if (field) {
      columnOf.set(field, i);
      recognized[field] = h.trim();
    } else if (h.trim()) ignored.push(h.trim());
  });

  const drafts: SheetProductDraft[] = [];
  const skipped: SheetParseResult['skipped'] = [];
  data.forEach((cells, index) => {
    const row = index + 1;
    const text = (f: Field) => {
      const i = columnOf.get(f);
      const v = i === undefined ? '' : (cells[i] ?? '').trim();
      return v ? v.slice(0, f === 'name' ? 200 : 120) : null;
    };
    const number = (f: Field) => {
      const i = columnOf.get(f);
      return i === undefined ? null : parseNumberCo(cells[i]);
    };
    const name = text('name') ?? text('sku');
    if (!name) {
      skipped.push({ row, reason: 'sin nombre ni código' });
      return;
    }
    const draft: SheetProductDraft = {
      row,
      sku: text('sku'),
      name,
      unit: text('unit'),
      category: text('category'),
      cost: positive(number('cost')),
      price: positive(number('price')),
      stock: number('stock'),
      minStock: positive(number('minStock')),
      reorderQty: positive(number('reorderQty')) || null,
      leadTimeDays: intOrNull(number('leadTimeDays')),
      supplierName: text('supplierName'),
      supplierTaxId: (text('supplierTaxId') ?? '').replace(/\D/g, '').slice(0, 15) || null,
      location: text('location'),
    };
    for (const f of Object.keys(draft) as Field[])
      if (!TEXT_FIELDS.has(f) && draft[f] === undefined)
        (draft as unknown as Record<string, null>)[f] = null;
    drafts.push(draft);
  });
  return { drafts, skipped, recognized, ignored };
}

function positive(n: number | null): number | null {
  return n !== null && n >= 0 ? n : null;
}

function intOrNull(n: number | null): number | null {
  if (n === null || n < 0) return null;
  return Math.min(Math.round(n), 365);
}
