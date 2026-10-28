/**
 * PEGAR DESDE EXCEL O SHEETS EN LA HOJA.
 *
 * Excel y Sheets copian TSV: celdas separadas por tabulación, filas por salto
 * de línea, y las celdas con saltos o comillas van entre comillas dobles
 * (RFC 4180 con tabulador). Aquí se lee ese texto, se decide a qué campo va
 * cada columna y se normaliza cada celda al formato que guarda la tabla
 * (números a la colombiana «3.433,71», fechas «04/03/2026», sí/no, opciones sin
 * mayúsculas ni tildes). Puro y sin dependencias de servidor: lo usan la hoja
 * (navegador) y el servidor, que vuelve a validar todo.
 */

export const PASTE_MAX_ROWS = 500;
export const PASTE_MAX_COLS = 40;

/** TSV del portapapeles → matriz de celdas. */
export function parseClipboard(text: string): string[][] {
  const src = text.replace(/\r\n?/g, '\n');
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let i = 0;
  while (i < src.length) {
    const ch = src[i] as string;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      cell += ch;
      i += 1;
      continue;
    }
    if (ch === '"' && cell === '') {
      quoted = true;
      i += 1;
      continue;
    }
    if (ch === '\t') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
    i += 1;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  // Excel deja un salto final: la última fila vacía no cuenta.
  while (rows.length && (rows[rows.length - 1] as string[]).every((c) => c.trim() === ''))
    rows.pop();
  return rows.map((r) => r.slice(0, PASTE_MAX_COLS));
}

const fold = (s: string) =>
  s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .trim();

/** «3.433,71», «$ 1.234.567», «0,09», «1,234.56», «-12», «15 %» → número; null si no lo es. */
export function parsePastedNumber(raw: string): number | null {
  let s = raw.trim().replace(/[\s$€£]|COP|USD/gi, '');
  if (!s) return null;
  let pct = false;
  if (s.endsWith('%')) {
    pct = true;
    s = s.slice(0, -1);
  }
  if (!/^[-+]?[\d.,]+$/.test(s)) return null;
  const neg = s.startsWith('-');
  s = s.replace(/^[-+]/, '');
  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  let normalized: string;
  if (lastDot >= 0 && lastComma >= 0) {
    // El último separador es el decimal.
    normalized =
      lastComma > lastDot ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  } else if (lastComma >= 0) {
    const parts = s.split(',');
    // «1,234,567» son miles; «0,09» o «3433,71» es decimal.
    normalized = parts.length > 2 ? parts.join('') : s.replace(',', '.');
  } else if (lastDot >= 0) {
    const parts = s.split('.');
    // «1.234.567» son miles (varios puntos, o uno con 3 dígitos detrás y 1-3 delante); «0.09» decimal.
    normalized =
      parts.length > 2 ||
      (parts.length === 2 &&
        (parts[1] as string).length === 3 &&
        (parts[0] as string).length >= 1 &&
        (parts[0] as string).length <= 3 &&
        Number(parts[0]) !== 0)
        ? parts.join('')
        : s;
  } else normalized = s;
  const n = Number(normalized);
  if (!Number.isFinite(n)) return null;
  const v = neg ? -n : n;
  return pct ? v / 100 : v;
}

const MONTHS: Record<string, number> = {
  ene: 1, enero: 1, jan: 1, feb: 2, febrero: 2, mar: 3, marzo: 3, abr: 4, abril: 4, apr: 4,
  may: 5, mayo: 5, jun: 6, junio: 6, jul: 7, julio: 7, ago: 8, agosto: 8, aug: 8,
  sep: 9, sept: 9, septiembre: 9, oct: 10, octubre: 10, nov: 11, noviembre: 11,
  dic: 12, diciembre: 12, dec: 12,
};

function iso(y: number, m: number, d: number): string | null {
  const yy = y < 100 ? 2000 + y : y;
  const t = new Date(Date.UTC(yy, m - 1, d));
  if (t.getUTCFullYear() !== yy || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
  return `${String(yy).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** «04/03/2026» (día primero, como en Colombia), «2026-03-04», «4-mar-26», «4 de marzo de 2026», serial de Excel → «YYYY-MM-DD». */
export function parsePastedDate(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T].*)?$/.exec(s);
  if (m) return iso(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2}|\d{4})(?:[ T].*)?$/.exec(s);
  if (m) return iso(Number(m[3]), Number(m[2]), Number(m[1]));
  m = /^(\d{1,2})[\s/.\-]+(?:de\s+)?([A-Za-zÀ-ÿ]{3,10})\.?[\s/.\-]+(?:de\s+)?(\d{2}|\d{4})$/.exec(s);
  if (m) {
    const mo = MONTHS[fold(m[2] as string)];
    return mo ? iso(Number(m[3]), mo, Number(m[1])) : null;
  }
  // Serial de Excel (días desde 1899-12-30): sólo en el rango de fechas plausibles.
  if (/^\d{5}(\.\d+)?$/.test(s)) {
    const n = Math.floor(Number(s));
    if (n >= 20000 && n <= 80000) {
      const t = new Date(Date.UTC(1899, 11, 30) + n * 86_400_000);
      return t.toISOString().slice(0, 10);
    }
  }
  return null;
}

export function parsePastedBool(raw: string): 0 | 1 | null {
  const s = fold(raw);
  if (['si', 's', 'x', '1', 'true', 'verdadero', 'yes', 'y', 'ok'].includes(s)) return 1;
  if (['no', 'n', '0', 'false', 'falso', ''].includes(s)) return 0;
  return null;
}

export interface PasteField {
  key: string;
  label: string;
  type: string;
  options: string[];
}

export type PasteCell = { ok: true; value: string } | { ok: false; error: string };

/** Una celda pegada → el texto que entiende la tabla (el servidor vuelve a validar). */
export function normalizePasteCell(field: PasteField, raw: string): PasteCell {
  const v = raw.trim();
  if (v === '') return { ok: true, value: '' };
  switch (field.type) {
    case 'number':
    case 'money': {
      const n = parsePastedNumber(v);
      return n === null
        ? { ok: false, error: `«${field.label}»: «${v}» no es un número.` }
        : { ok: true, value: String(n) };
    }
    case 'date': {
      const d = parsePastedDate(v);
      return d
        ? { ok: true, value: d }
        : { ok: false, error: `«${field.label}»: «${v}» no es una fecha (usa día/mes/año).` };
    }
    case 'checkbox': {
      const b = parsePastedBool(v);
      return b === null
        ? { ok: false, error: `«${field.label}»: «${v}» no es sí o no.` }
        : { ok: true, value: String(b) };
    }
    case 'select': {
      const hit = field.options.find((o) => fold(o) === fold(v));
      return hit
        ? { ok: true, value: hit }
        : {
            ok: false,
            error: `«${field.label}»: «${v}» no es una opción (${field.options.join(', ')}).`,
          };
    }
    default:
      return { ok: true, value: v };
  }
}

/**
 * Qué columna pegada va a qué campo. Si la primera fila se parece a los
 * encabezados de las columnas (por nombre, sin tildes ni mayúsculas) se usa y
 * se omite; si no, se pega en orden desde `startCol`.
 */
export function mapPasteColumns(
  matrix: string[][],
  columns: PasteField[],
  startCol = 0,
): { header: boolean; targets: Array<PasteField | null>; body: string[][] } {
  const first = matrix[0] ?? [];
  const byName = (cell: string) =>
    columns.find((c) => fold(c.label) === fold(cell) || fold(c.key) === fold(cell)) ?? null;
  const named = first.map(byName);
  const hits = named.filter(Boolean).length;
  if (first.length && hits >= Math.max(2, Math.ceil(first.length / 2)))
    return { header: true, targets: named, body: matrix.slice(1) };
  const width = Math.max(0, ...matrix.map((r) => r.length));
  return {
    header: false,
    targets: Array.from({ length: width }, (_, i) => columns[startCol + i] ?? null),
    body: matrix,
  };
}

export interface PasteRow {
  /** Posición (1-based) en lo pegado, para decir «fila 7». */
  line: number;
  values: Record<string, string>;
  errors: string[];
}

/** Matriz + destinos → filas con valores normalizados y los errores celda a celda. */
export function buildPasteRows(body: string[][], targets: Array<PasteField | null>): PasteRow[] {
  return body.slice(0, PASTE_MAX_ROWS).map((cells, i) => {
    const values: Record<string, string> = {};
    const errors: string[] = [];
    targets.forEach((field, c) => {
      if (!field) return;
      const out = normalizePasteCell(field, cells[c] ?? '');
      if (!out.ok) errors.push(out.error);
      else if (out.value !== '') values[field.key] = out.value;
    });
    return { line: i + 1, values, errors };
  });
}

/** TSV de una matriz (para «Copiar» y pruebas de ida y vuelta). */
export function toClipboard(matrix: string[][]): string {
  return matrix
    .map((r) =>
      r.map((c) => (/[\t\n"]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join('\t'),
    )
    .join('\n');
}
