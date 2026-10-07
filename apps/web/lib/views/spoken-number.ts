/**
 * NÚMEROS COMO SE DICEN EN COLOMBIA. Puro, sin servidor: lo usan el dictado
 * (dictate.ts, en el servidor) y el asistente de voz (voice-form.ts, en el
 * navegador), por eso vive aparte de los dos.
 */

/**
 * Un número como lo escribe el modelo o la persona en Colombia: «1.200.000»
 * es un millón doscientos mil (punto de miles), «3,5» es tres y medio (coma
 * decimal), «1200000» y «3.5» también valen. Lo que no es un número: null.
 */
export function parseSpokenNumber(raw: string): number | null {
  let s = raw.replace(/[$\s]/g, '').replace(/^COP/i, '');
  if (!/^-?[\d.,]+$/.test(s) || !/\d/.test(s)) return null;
  if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  else if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, '');
  else s = s.replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Sin tildes, en minúsculas y sin signos: lo que se compara de lo que se oyó. */
export function foldSpoken(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9ñ$:/.,\-\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

type Kind = 'unit' | 'teen' | 'tens' | 'hund' | 'scale';
const WORDS = new Map<string, [Kind, number]>();
const put = (kind: Kind, words: string[], from: number, step = 1) =>
  words.forEach((w, i) => WORDS.set(w, [kind, from + i * step]));
put('unit', ['cero', 'uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve'], 0);
WORDS.set('un', ['unit', 1]);
WORDS.set('una', ['unit', 1]);
put(
  'teen',
  [
    'diez',
    'once',
    'doce',
    'trece',
    'catorce',
    'quince',
    'dieciseis',
    'diecisiete',
    'dieciocho',
    'diecinueve',
    'veinte',
    'veintiuno',
    'veintiun',
    'veintiuna',
    'veintidos',
    'veintitres',
    'veinticuatro',
    'veinticinco',
    'veintiseis',
    'veintisiete',
    'veintiocho',
    'veintinueve',
  ],
  10,
);
// «veintiuno» y sus variantes no siguen la secuencia: se corrigen.
for (const [w, n] of [
  ['veinte', 20],
  ['veintiuno', 21],
  ['veintiun', 21],
  ['veintiuna', 21],
  ['veintidos', 22],
  ['veintitres', 23],
  ['veinticuatro', 24],
  ['veinticinco', 25],
  ['veintiseis', 26],
  ['veintisiete', 27],
  ['veintiocho', 28],
  ['veintinueve', 29],
] as const)
  WORDS.set(w, ['teen', n]);
put(
  'tens',
  ['treinta', 'cuarenta', 'cincuenta', 'sesenta', 'setenta', 'ochenta', 'noventa'],
  30,
  10,
);
WORDS.set('cien', ['hund', 100]);
WORDS.set('ciento', ['hund', 100]);
WORDS.set('doscientos', ['hund', 200]);
WORDS.set('doscientas', ['hund', 200]);
WORDS.set('trescientos', ['hund', 300]);
WORDS.set('cuatrocientos', ['hund', 400]);
WORDS.set('quinientos', ['hund', 500]);
WORDS.set('seiscientos', ['hund', 600]);
WORDS.set('setecientos', ['hund', 700]);
WORDS.set('ochocientos', ['hund', 800]);
WORDS.set('novecientos', ['hund', 900]);
WORDS.set('mil', ['scale', 1000]);
WORDS.set('millon', ['scale', 1_000_000]);
WORDS.set('millones', ['scale', 1_000_000]);

const DIGIT_WORD: Record<string, string> = {
  cero: '0',
  uno: '1',
  un: '1',
  una: '1',
  dos: '2',
  tres: '3',
  cuatro: '4',
  cinco: '5',
  seis: '6',
  siete: '7',
  ocho: '8',
  nueve: '9',
};

const clean = (t: string) => t.replace(/[,;:!?¡¿]+$/g, '').replace(/\.+$/g, '');

/**
 * Todos los números que trae una frase, en orden: cifras («4», «1.200.000») y
 * palabras («cuatro», «treinta y dos», «dos mil quinientos», «tres punto
 * cinco»). Dos números sueltos («cuatro cinco») son dos números, no nueve.
 */
export function spokenNumbers(text: string): number[] {
  const tokens = foldSpoken(text).split(' ').map(clean).filter(Boolean);
  const out: number[] = [];
  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i] as string;
    if (/^-?\d[\d.,]*$/.test(tok)) {
      const n = parseSpokenNumber(tok);
      if (n !== null) out.push(n);
      i += 1;
      continue;
    }
    if (!WORDS.has(tok)) {
      i += 1;
      continue;
    }
    // Una carrera de palabras de número que se pueden pegar.
    let total = 0;
    let current = 0;
    let last: Kind | 'y' | 'start' = 'start';
    let j = i;
    while (j < tokens.length) {
      const w = tokens[j] as string;
      if (w === 'y' && last === 'tens' && WORDS.get(tokens[j + 1] ?? '')?.[0] === 'unit') {
        last = 'y';
        j += 1;
        continue;
      }
      const hit = WORDS.get(w);
      if (!hit) break;
      const [kind, v] = hit;
      const ok =
        last === 'start' ||
        (last === 'hund' && kind !== 'hund') ||
        (last === 'y' && kind === 'unit') ||
        (last === 'scale' && true) ||
        ((last === 'unit' || last === 'teen' || last === 'tens') && kind === 'scale');
      if (!ok) break;
      if (kind === 'scale') {
        total += (current || 1) * v;
        current = 0;
      } else current += v;
      last = kind;
      j += 1;
    }
    let n = total + current;
    // «tres punto cinco» / «tres coma cinco».
    if (
      (tokens[j] === 'punto' || tokens[j] === 'coma') &&
      DIGIT_WORD[tokens[j + 1] ?? ''] !== undefined
    ) {
      let dec = '';
      let k = j + 1;
      while (DIGIT_WORD[tokens[k] ?? ''] !== undefined) {
        dec += DIGIT_WORD[tokens[k] as string];
        k += 1;
      }
      n = Number(`${n}.${dec}`);
      j = k;
    }
    out.push(n);
    i = Math.max(j, i + 1);
  }
  return out;
}

/**
 * Lo dicho como código: «siete veintinueve, uno dos tres» → «7 29 1 2 3» sin
 * espacios («729123»). Lo que no es número se deja tal cual (letras
 * deletreadas, guiones).
 */
export function spokenDigits(text: string): string {
  const tokens = foldSpoken(text).split(' ').map(clean).filter(Boolean);
  let out = '';
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i] as string;
    const hit = WORDS.get(t);
    if (!hit) {
      out += t;
      continue;
    }
    const [kind, v] = hit;
    if (kind === 'unit') out += String(v);
    else if (kind === 'teen') out += String(v);
    else if (kind === 'tens') {
      if (tokens[i + 1] === 'y' && WORDS.get(tokens[i + 2] ?? '')?.[0] === 'unit') {
        out += String(v + (WORDS.get(tokens[i + 2] as string)?.[1] ?? 0));
        i += 2;
      } else out += String(v);
    } else out += t;
  }
  return out;
}
