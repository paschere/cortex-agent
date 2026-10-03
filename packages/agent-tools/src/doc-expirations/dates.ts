/**
 * Fechas escritas en español, leídas sin modelo.
 *
 * Es la segunda mitad de la regla de 0069 («la fecha tiene que estar escrita
 * en la cita»): el modelo propone una fecha y una frase; este archivo lee la
 * frase por su cuenta y sólo cree la fecha si la encuentra escrita ahí. Por
 * eso es puro y está probado aparte — es la parte que decide qué se vigila.
 *
 * Lo que entiende, que es lo que traen los papeles colombianos:
 *
 *   15 de marzo de 2027 · 15 de marzo del 2027 · 1° de abril de 2026 ·
 *   primero de abril de 2026 · 15 marzo 2027 · marzo 15 de 2027 ·
 *   15-mar-2027 · 15/MAR/2027 · 01/04/2026 · 1-4-2026 · 01.04.2026 ·
 *   31/03/27 · 2026-04-01 · 2026/04/01
 *
 * Los numéricos se leen DÍA/MES/AÑO, que es como se escriben aquí: «04/01/2026»
 * es el 4 de enero, nunca el 1 de abril. El orden gringo sólo se acepta cuando
 * no hay otra lectura posible («03/31/2027»: 31 no es un mes). Ver
 * `numericDate`.
 *
 * Y los RANGOS, que es lo que de verdad importa en una póliza o un SOAT:
 *
 *   «vigente hasta el 15 de marzo de 2027»       → hasta 2027-03-15
 *   «desde 01/04/2026 hasta 31/03/2027»          → desde y hasta
 *   «vigencia del 1 de abril de 2026 al 31 de marzo de 2027»
 *   «fecha de vencimiento: 31/03/2027» · «vence el …» · «expira el …»
 *   «fecha de expedición: 02/04/2026» · «inicio de vigencia …»
 */

export interface DateHit {
  /** YYYY-MM-DD */
  iso: string;
  /** Posición en el texto original, para leer lo que hay antes. */
  index: number;
  end: number;
  raw: string;
}

const MONTHS: Record<string, number> = {
  enero: 1,
  ene: 1,
  febrero: 2,
  feb: 2,
  marzo: 3,
  mar: 3,
  abril: 4,
  abr: 4,
  mayo: 5,
  may: 5,
  junio: 6,
  jun: 6,
  julio: 7,
  jul: 7,
  agosto: 8,
  ago: 8,
  septiembre: 9,
  setiembre: 9,
  sep: 9,
  sept: 9,
  set: 9,
  octubre: 10,
  oct: 10,
  noviembre: 11,
  nov: 11,
  diciembre: 12,
  dic: 12,
};

const MONTH_ALT = Object.keys(MONTHS)
  .sort((a, b) => b.length - a.length)
  .join('|');

/** Minúsculas y sin tildes, CONSERVANDO las posiciones (una letra por letra). */
function fold(text: string): string {
  let out = '';
  for (const ch of text) {
    const base = ch.normalize('NFD').replace(/\p{M}/gu, '');
    // Una letra con tilde se vuelve exactamente una letra; cualquier otro
    // carácter se queda como está para no correr los índices.
    out += (base.length === 1 ? base : ch).toLowerCase();
  }
  return out;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** Un día de calendario real, o null. */
export function makeIso(year: number, month: number, day: number): string | null {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  if (year < 1950 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return `${year}-${pad(month)}-${pad(day)}`;
}

function fullYear(raw: string): number {
  const n = Number(raw);
  return raw.length === 2 ? 2000 + n : n;
}

/**
 * DÍA/MES/AÑO. La única lectura alternativa es cuando el SEGUNDO número pasa
 * de 12 (no puede ser mes) y el primero sí puede serlo: «03/31/2027» → 31 de
 * marzo.
 */
function numericDate(a: number, b: number, year: number): string | null {
  if (b > 12 && a <= 12) return makeIso(year, a, b);
  return makeIso(year, b, a);
}

const PATTERNS: Array<{ re: RegExp; read: (m: RegExpExecArray) => string | null }> = [
  // 2026-04-01 · 2026/04/01
  {
    re: /\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/g,
    read: (m) => makeIso(Number(m[1]), Number(m[2]), Number(m[3])),
  },
  // 01/04/2026 · 1-4-2026 · 01.04.2026 · 31/03/27
  {
    re: /\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{4}|\d{2})\b/g,
    read: (m) => numericDate(Number(m[1]), Number(m[2]), fullYear(m[3] as string)),
  },
  // 15 de marzo de 2027 · 1° de abril del 2026 · primero de abril de 2026 ·
  // 15 marzo 2027 · 15-mar-2027 · 15/mar/2027 · 15 de marzo, 2027
  {
    re: new RegExp(
      `\\b(\\d{1,2}|primero)\\s*(?:°|º|o\\b|ro\\b)?\\s*(?:de\\s+|[-/.\\s])\\s*(${MONTH_ALT})\\b\\.?\\s*(?:,\\s*)?(?:de(?:l)?\\s+|[-/.\\s])\\s*(?:ano\\s+)?(\\d{4})\\b`,
      'g',
    ),
    read: (m) =>
      makeIso(Number(m[3]), MONTHS[m[2] as string] ?? 0, m[1] === 'primero' ? 1 : Number(m[1])),
  },
  // marzo 15 de 2027 · marzo 15, 2027
  {
    re: new RegExp(
      `\\b(${MONTH_ALT})\\b\\.?\\s+(\\d{1,2})\\b\\s*(?:,|de(?:l)?)?\\s*(\\d{4})\\b`,
      'g',
    ),
    read: (m) => makeIso(Number(m[3]), MONTHS[m[1] as string] ?? 0, Number(m[2])),
  },
];

/** Todas las fechas escritas en el texto, en orden de aparición, sin repetir posición. */
export function findDates(text: string): DateHit[] {
  const folded = fold(text);
  const hits: DateHit[] = [];
  for (const { re, read } of PATTERNS) {
    re.lastIndex = 0;
    for (let m = re.exec(folded); m; m = re.exec(folded)) {
      const iso = read(m);
      if (!iso) continue;
      const index = m.index;
      const end = index + m[0].length;
      // Un patrón más largo ya cubrió este tramo (p. ej. «2026-04-01» no
      // es también «26-04-01»).
      if (hits.some((h) => index < h.end && end > h.index)) continue;
      hits.push({ iso, index, end, raw: text.slice(index, end) });
    }
  }
  return hits.sort((a, b) => a.index - b.index);
}

/** ¿Está esta fecha (YYYY-MM-DD) escrita en esta frase? Leída, no parecida. */
export function quoteStatesDate(quote: string, iso: string): boolean {
  return findDates(quote).some((h) => h.iso === iso);
}

// ---------------------------------------------------------------------------
// Desde / hasta
// ---------------------------------------------------------------------------

/** Palabras que, justo antes de una fecha, la vuelven el FIN de la vigencia. */
const UNTIL_CUES = [
  'hasta',
  'vence',
  'vencimiento',
  'vencera',
  'expira',
  'expiracion',
  'caduca',
  'fin de vigencia',
  'fin vigencia',
  'final de vigencia',
  'fecha fin',
  'fecha final',
  'termina',
  'terminacion',
  'valido hasta',
  'valida hasta',
  'vigente hasta',
  'al',
];

/** Palabras que la vuelven el COMIENZO (o la expedición). */
const FROM_CUES = [
  'desde',
  'del',
  'expedicion',
  'expedido',
  'expedida',
  'expide',
  'emision',
  'emitido',
  'emitida',
  'inicio de vigencia',
  'inicio vigencia',
  'fecha inicio',
  'fecha de inicio',
  'a partir',
  'otorgad',
  'suscrit',
  'firmad',
];

function cueBefore(text: string, index: number, cues: string[]): number {
  const before = fold(text.slice(Math.max(0, index - 48), index));
  let best = -1;
  for (const cue of cues) {
    // La pista más CERCANA a la fecha es la que manda («expedida el 2 de
    // abril, vigente hasta el …» tiene las dos, cada una pegada a su fecha).
    const re = new RegExp(`(?:^|[^a-z])${cue}(?:[^a-z]|$)`, 'g');
    for (let m = re.exec(before); m; m = re.exec(before)) {
      best = Math.max(best, m.index + m[0].length);
    }
  }
  return best === -1 ? -1 : before.length - best;
}

export interface Validity {
  from: DateHit | null;
  until: DateHit | null;
}

/**
 * Desde cuándo y hasta cuándo, según lo que dice el texto.
 *
 * Cada fecha mira las palabras que tiene justo antes: «hasta», «vence»,
 * «al» la hacen fin; «desde», «del», «expedición» la hacen comienzo; gana la
 * pista más cercana. Si no hay pistas pero hay exactamente dos fechas, la
 * menor es el comienzo y la mayor el fin (es la forma de «01/04/2026 -
 * 31/03/2027» en una casilla de vigencia). Con una sola fecha sin pista NO se
 * decide nada: una fecha suelta puede ser la de impresión.
 */
export function readValidity(text: string): Validity {
  const hits = findDates(text);
  let from: DateHit | null = null;
  let until: DateHit | null = null;
  const unlabeled: DateHit[] = [];

  for (const hit of hits) {
    const u = cueBefore(text, hit.index, UNTIL_CUES);
    const f = cueBefore(text, hit.index, FROM_CUES);
    if (u === -1 && f === -1) {
      unlabeled.push(hit);
      continue;
    }
    const isUntil = u !== -1 && (f === -1 || u <= f);
    if (isUntil) {
      if (!until || hit.iso > until.iso) until = hit;
    } else if (!from || hit.iso < from.iso) {
      from = hit;
    }
  }

  if (!from && !until && unlabeled.length === 2) {
    const [a, b] = unlabeled as [DateHit, DateHit];
    if (a.iso !== b.iso) {
      from = a.iso < b.iso ? a : b;
      until = a.iso < b.iso ? b : a;
    }
  }
  if (from && until && from.iso > until.iso) {
    // Un «desde» posterior al «hasta» es una lectura equivocada, no un dato.
    return { from: null, until: null };
  }
  return { from, until };
}
