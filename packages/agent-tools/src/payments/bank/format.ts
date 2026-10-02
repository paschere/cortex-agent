/**
 * Leer números, fechas y encabezados como los escribe un banco colombiano.
 *
 * Funciones puras, sin base de datos y sin archivos, para que cada regla tenga
 * su test. Tres cosas hacen difícil un extracto, y las tres se resuelven aquí:
 *
 *   EL SEPARADOR DECIMAL NO ES UNIVERSAL. «1.234.567,89» (es-CO) y
 *   «1,234,567.89» (como lo exporta media banca en línea) son el mismo número.
 *   Se decide por COLUMNA y no por celda (`inferDecimalStyle`): mirar «1.234» a
 *   solas no dice si son mil doscientos o uno coma dos, mirar la columna entera
 *   sí. Cuando la columna no lo dice, «1.234» son mil doscientos treinta y
 *   cuatro: en pesos nadie escribe tres decimales.
 *
 *   LA FECHA ES DÍA/MES. dd/mm/aaaa es lo normal; si una fila de la columna
 *   trae un «mes» mayor que 12, la columna entera es mes/día y se lee así
 *   (`inferDateOrder`). Nunca se decide fila por fila: un 03/04 leído distinto
 *   que el 13/04 de abajo es un mes corrido en silencio.
 *
 *   EL ENCABEZADO VIENE CON TILDES, PUNTOS Y MAYÚSCULAS. «DCTO.», «Descripción»
 *   y «FECHA DE SISTEMA» se comparan normalizados (`normalizeHeader`).
 */

export type Cell = string | number | boolean | null | undefined;

/** Minúsculas, sin tildes, sin puntuación, espacios simples. «DCTO.» → «dcto». */
export function normalizeHeader(raw: Cell): string {
  return String(raw ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9ñ]+/g, ' ')
    .trim();
}

/** Mayúsculas sin tildes y con espacios simples: para comparar descripciones. */
export function normalizeText(raw: Cell): string {
  return String(raw ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export function cellText(raw: Cell): string {
  if (raw == null) return '';
  return String(raw).replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Importes
// ---------------------------------------------------------------------------

/** Qué carácter es el decimal en una columna: la coma (es-CO) o el punto. */
export type DecimalStyle = 'comma' | 'dot';

/** Quita moneda, espacios y signos; devuelve el signo aparte. */
function stripAmount(raw: string): { body: string; negative: boolean } | null {
  let s = raw.replace(/[\s ]/g, '').replace(/−/g, '-');
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  s = s.replace(/^(COP|USD|EUR)/i, '').replace(/(COP|USD|EUR)$/i, '');
  if (s.startsWith('-')) {
    negative = !negative;
    s = s.slice(1);
  } else if (s.startsWith('+')) {
    s = s.slice(1);
  }
  s = s.replace(/^\$/, '');
  if (s.startsWith('-')) {
    negative = !negative;
    s = s.slice(1);
  }
  if (s.endsWith('-')) {
    negative = !negative;
    s = s.slice(0, -1);
  }
  if (!/^[\d.,']+$/.test(s) || !/\d/.test(s)) return null;
  return { body: s.replace(/'/g, ''), negative };
}

/**
 * El voto de una celda: qué separador es el decimal, si lo dice. «1.234,56» lo
 * dice (el último es el decimal); «1,234,567» lo dice (la coma agrupa miles);
 * «1.234» no lo dice del todo, pero en pesos se lee como miles.
 */
function voteOf(body: string): DecimalStyle | null {
  const hasDot = body.includes('.');
  const hasComma = body.includes(',');
  if (hasDot && hasComma) return body.lastIndexOf(',') > body.lastIndexOf('.') ? 'comma' : 'dot';
  if (hasComma) {
    if (/^\d{1,3}(,\d{3}){2,}$/.test(body)) return 'dot';
    if (/,\d{1,2}$/.test(body)) return 'comma';
    return null;
  }
  if (hasDot) {
    if (/^\d{1,3}(\.\d{3}){2,}$/.test(body)) return 'comma';
    if (/\.\d{1,2}$/.test(body)) return 'dot';
    return null;
  }
  return null;
}

/** El estilo decimal de una columna entera, por mayoría. Nulo si nadie lo dice. */
export function inferDecimalStyle(values: Cell[]): DecimalStyle | null {
  let comma = 0;
  let dot = 0;
  for (const v of values) {
    if (typeof v !== 'string') continue;
    const stripped = stripAmount(v);
    if (!stripped) continue;
    const vote = voteOf(stripped.body);
    if (vote === 'comma') comma += 1;
    else if (vote === 'dot') dot += 1;
  }
  if (comma === 0 && dot === 0) return null;
  return comma >= dot ? 'comma' : 'dot';
}

/**
 * Un importe con signo, o nulo si la celda no es un número.
 *
 * Acepta «$ 1.234.567,89», «1,234,567.89», «-1.200», «(1.200,00)», «1.200,00-»
 * y los números que ya vienen como número desde Excel.
 */
export function parseAmount(raw: Cell, style: DecimalStyle | null = null): number | null {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw === 'boolean') return null;
  const stripped = stripAmount(String(raw));
  if (!stripped) return null;
  const { body, negative } = stripped;

  let decimal: '.' | ',' | null = null;
  const hasDot = body.includes('.');
  const hasComma = body.includes(',');
  if (hasDot && hasComma) {
    decimal = body.lastIndexOf(',') > body.lastIndexOf('.') ? ',' : '.';
  } else if (hasDot || hasComma) {
    const sep = hasDot ? '.' : ',';
    const parts = body.split(sep);
    const tail = parts[parts.length - 1] ?? '';
    if (parts.length > 2) {
      // Dos o más del mismo separador: agrupa miles, o el número está mal.
      if (!parts.slice(1).every((p) => p.length === 3)) return null;
      decimal = null;
    } else if (tail.length === 3) {
      // «1.234» o «1,234»: miles, salvo que la columna diga que ESE es el decimal.
      const styleChar = style === 'comma' ? ',' : style === 'dot' ? '.' : null;
      decimal = styleChar === sep ? sep : null;
    } else {
      decimal = sep;
    }
  }

  let normalized = body;
  if (decimal === ',') normalized = body.replace(/\./g, '').replace(',', '.');
  else if (decimal === '.') normalized = body.replace(/,/g, '');
  else normalized = body.replace(/[.,]/g, '');
  const n = Number(normalized);
  if (!Number.isFinite(n)) return null;
  const value = Math.round(n * 100) / 100;
  return negative ? -value : value;
}

// ---------------------------------------------------------------------------
// Fechas
// ---------------------------------------------------------------------------

export type DateOrder = 'dmy' | 'mdy';

const MONTHS: Record<string, number> = {
  ene: 1,
  jan: 1,
  feb: 2,
  mar: 3,
  abr: 4,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  ago: 8,
  aug: 8,
  sep: 9,
  set: 9,
  oct: 10,
  nov: 11,
  dic: 12,
  dec: 12,
};

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function isoOf(y: number, m: number, d: number): string | null {
  if (y < 1990 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const t = Date.UTC(y, m - 1, d);
  const back = new Date(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d) {
    return null;
  }
  return `${y}-${pad(m)}-${pad(d)}`;
}

function fullYear(y: number): number {
  return y < 100 ? 2000 + y : y;
}

/** Las dos primeras partes numéricas de «13/04/2026», para decidir el orden. */
function slashParts(raw: string): [number, number] | null {
  const m = /^(\d{1,2})[/.-](\d{1,2})(?:[/.-]\d{2,4})?(?:\s|$)/.exec(raw.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2])];
}

/** dd/mm salvo que alguna fila de la columna lo contradiga. */
export function inferDateOrder(values: Cell[]): DateOrder {
  let dmy = false;
  let mdy = false;
  for (const v of values) {
    if (typeof v !== 'string') continue;
    const parts = slashParts(v);
    if (!parts) continue;
    if (parts[0] > 12) dmy = true;
    if (parts[1] > 12) mdy = true;
  }
  return mdy && !dmy ? 'mdy' : 'dmy';
}

/**
 * Una fecha de calendario AAAA-MM-DD, o nulo.
 *
 * Acepta dd/mm/aaaa, dd-mm-aa, aaaa-mm-dd (con o sin hora, que es como llega
 * una celda de fecha de Excel), aaaammdd, «15-ene-2026», «15 ENE 2026», el
 * número de serie de Excel, y dd/mm sin año cuando el extracto dice el año en
 * otra parte (`fallbackYear`).
 */
export function parseDate(
  raw: Cell,
  order: DateOrder = 'dmy',
  fallbackYear: number | null = null,
): string | null {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'number') {
    if (raw >= 19_000_000 && raw <= 21_001_231 && Number.isInteger(raw)) {
      return parseDate(String(raw), order, fallbackYear);
    }
    // Número de serie de Excel: días desde el 30/12/1899.
    if (raw > 30_000 && raw < 80_000) {
      const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(raw) * 86_400_000);
      return isoOf(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
    }
    return null;
  }
  if (typeof raw === 'boolean') return null;
  const s = String(raw).trim();
  if (!s) return null;

  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T\s].*)?$/.exec(s);
  if (m) return isoOf(Number(m[1]), Number(m[2]), Number(m[3]));

  m = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (m) return isoOf(Number(m[1]), Number(m[2]), Number(m[3]));

  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})(?:\s.*)?$/.exec(s);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const y = fullYear(Number(m[3]));
    return order === 'mdy' ? isoOf(y, a, b) : isoOf(y, b, a);
  }

  m = /^(\d{1,2})[-/\s.]+([a-záéíóú]{3,})\.?[-/\s.]+(\d{2}|\d{4})(?:\s.*)?$/i.exec(s);
  if (m) {
    const month = MONTHS[normalizeHeader(m[2]).slice(0, 3)];
    if (month) return isoOf(fullYear(Number(m[3])), month, Number(m[1]));
  }

  m = /^(\d{1,2})[-/.](\d{1,2})$/.exec(s);
  if (m && fallbackYear) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    return order === 'mdy' ? isoOf(fallbackYear, a, b) : isoOf(fallbackYear, b, a);
  }
  return null;
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/** Quita el BOM y elige UTF-8 o Windows-1252, que es como exporta media banca. */
export function decodeText(bytes: Uint8Array): string {
  let start = 0;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) start = 3;
  const body = bytes.subarray(start);
  const utf8 = new TextDecoder('utf-8').decode(body);
  if (!utf8.includes('�')) return utf8;
  try {
    return new TextDecoder('windows-1252').decode(body);
  } catch {
    return new TextDecoder('latin1').decode(body);
  }
}

function countOutsideQuotes(line: string, ch: string): number {
  let n = 0;
  let quoted = false;
  for (const c of line) {
    if (c === '"') quoted = !quoted;
    else if (c === ch && !quoted) n += 1;
  }
  return n;
}

/** `;`, `,`, tabulador o `|`: el que aparezca de forma más pareja en las primeras líneas. */
export function detectDelimiter(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0)
    .slice(0, 25);
  let best = ',';
  let bestScore = -1;
  for (const ch of [';', ',', '\t', '|']) {
    const counts = lines.map((l) => countOutsideQuotes(l, ch)).filter((n) => n > 0);
    if (counts.length === 0) continue;
    const freq = new Map<number, number>();
    for (const c of counts) freq.set(c, (freq.get(c) ?? 0) + 1);
    const [mode, times] = [...freq.entries()].sort((a, b) => b[1] - a[1])[0] ?? [0, 0];
    const score = times * 10 + mode;
    if (score > bestScore) {
      bestScore = score;
      best = ch;
    }
  }
  return best;
}

/** CSV con comillas a la RFC 4180. Todo queda como texto: los números los lee `parseAmount`. */
export function parseCsv(text: string, delimiter = detectDelimiter(text)): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"' && field.trim() === '') {
      quoted = true;
      field = '';
    } else if (c === delimiter) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.map((r) => r.map((f) => f.trim()));
}
