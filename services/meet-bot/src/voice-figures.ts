/**
 * Aura no tiene SSML: las cifras se expanden a español en voice-figures.ts
 * antes de Speak. El transcript sigue con dígitos.
 */

const UNITS = ['cero', 'uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve'];
const TEENS = [
  'diez',
  'once',
  'doce',
  'trece',
  'catorce',
  'quince',
  'dieciséis',
  'diecisiete',
  'dieciocho',
  'diecinueve',
];
const TENS = [
  '',
  '',
  'veinte',
  'treinta',
  'cuarenta',
  'cincuenta',
  'sesenta',
  'setenta',
  'ochenta',
  'noventa',
];
const HUNDREDS = [
  '',
  'ciento',
  'doscientos',
  'trescientos',
  'cuatrocientos',
  'quinientos',
  'seiscientos',
  'setecientos',
  'ochocientos',
  'novecientos',
];

/** `un mil` no se dice; `veintiún mil` sí. */
function under100(n: number, apocope: boolean): string {
  if (n < 10) return n === 1 && apocope ? 'un' : (UNITS[n] as string);
  if (n < 20) return TEENS[n - 10] as string;
  if (n === 21) return apocope ? 'veintiún' : 'veintiuno';
  if (n < 30) {
    const u = n - 20;
    if (u === 2) return 'veintidós';
    if (u === 3) return 'veintitrés';
    if (u === 6) return 'veintiséis';
    return `veinti${UNITS[u]}`;
  }
  const t = Math.floor(n / 10);
  const u = n % 10;
  if (u === 0) return TENS[t] as string;
  return `${TENS[t]} y ${u === 1 && apocope ? 'un' : UNITS[u]}`;
}

function under1000(n: number, apocope: boolean): string {
  if (n < 100) return under100(n, apocope);
  if (n === 100) return 'cien';
  const h = Math.floor(n / 100);
  const rest = n % 100;
  if (rest === 0) return h === 1 ? 'cien' : (HUNDREDS[h] as string);
  return `${HUNDREDS[h]} ${under100(rest, apocope)}`;
}

export function integerToSpanish(n: number, apocope = false): string {
  if (!Number.isFinite(n)) return String(n);
  const v = Math.trunc(n);
  if (v < 0) return `menos ${integerToSpanish(-v, apocope)}`;
  if (v === 0) return 'cero';
  if (v >= 1_000_000_000_000) return String(v);

  const billions = Math.floor(v / 1_000_000_000);
  const millions = Math.floor((v % 1_000_000_000) / 1_000_000);
  const thousands = Math.floor((v % 1_000_000) / 1_000);
  const rest = v % 1_000;
  const parts: string[] = [];
  if (billions) {
    parts.push(billions === 1 ? 'mil millones' : `${integerToSpanish(billions, true)} mil millones`);
  }
  if (millions) {
    parts.push(millions === 1 ? 'un millón' : `${integerToSpanish(millions, true)} millones`);
  }
  if (thousands) {
    parts.push(thousands === 1 ? 'mil' : `${under1000(thousands, true)} mil`);
  }
  if (rest) parts.push(under1000(rest, apocope));
  return parts.join(' ');
}

type Parsed = {
  int: number;
  frac: string | null;
  currency: 'COP' | 'USD' | null;
  percent: boolean;
};

function parseFigure(raw: string): Parsed | null {
  let s = raw.trim();
  const percent = s.endsWith('%');
  if (percent) s = s.slice(0, -1).trim();
  let currency: Parsed['currency'] = null;
  if (/^\$/.test(s) || /\bCOP\b/i.test(s) || /\bpesos?\b/i.test(s)) currency = 'COP';
  if (/\bUSD\b/i.test(s) || /\bdólares?\b/i.test(s) || /\bdolares?\b/i.test(s)) currency = 'USD';
  s = s
    .replace(/^\$/, '')
    .replace(/\b(USD|COP|pesos?|d[oó]lares?)\b/gi, '')
    .trim();
  if (!s || !/\d/.test(s)) return null;

  let intPart: string;
  let frac: string | null = null;
  if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) {
    const [a, b] = s.split(',');
    intPart = (a ?? '').replace(/\./g, '');
    frac = b ?? null;
  } else if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) {
    const [a, b] = s.split('.');
    intPart = (a ?? '').replace(/,/g, '');
    frac = b ?? null;
  } else if (/^\d+,\d{1,4}$/.test(s)) {
    const [a, b] = s.split(',');
    intPart = a ?? '0';
    frac = b ?? null;
  } else if (/^\d+\.\d{1,2}$/.test(s)) {
    const [a, b] = s.split('.');
    intPart = a ?? '0';
    frac = b ?? null;
  } else if (/^\d{1,3}(\.\d{3})+$/.test(s)) {
    intPart = s.replace(/\./g, '');
  } else if (/^\d+$/.test(s)) {
    intPart = s;
  } else {
    return null;
  }
  const int = Number(intPart);
  if (!Number.isFinite(int)) return null;
  return { int, frac, currency, percent };
}

function speakFrac(frac: string, money: boolean): string {
  const digits = frac.replace(/\D/g, '');
  if (!digits) return '';
  if (money && digits.length <= 2) {
    const cents = Number(digits.padEnd(2, '0').slice(0, 2));
    if (cents === 0) return '';
    return `con ${integerToSpanish(cents)}`;
  }
  if (digits.length <= 2) return `coma ${integerToSpanish(Number(digits))}`;
  return `coma ${digits.split('').map((d) => UNITS[Number(d)]).join(' ')}`;
}

function spokenFigure(p: Parsed, followedByUnit: boolean): string {
  const money = !p.percent && (p.currency !== null || followedByUnit);
  const head = integerToSpanish(p.int, money);
  const frac = p.frac ? speakFrac(p.frac, money) : '';
  const body = [head, frac].filter(Boolean).join(' ');
  if (p.percent) return `${body} por ciento`;
  if (followedByUnit) return body;
  if (p.currency === 'USD') return `${body} ${p.int === 1 && !p.frac ? 'dólar' : 'dólares'}`;
  if (p.currency === 'COP') return `${body} ${p.int === 1 && !p.frac ? 'peso' : 'pesos'}`;
  return body;
}

const UNIT_AFTER = /^(pesos?|d[oó]lares?|centavos?|uvt|puntos?)\b/i;
const SKIP = /^(?:\d+\.\d+\.\d+|\d{3}\.\d{3}\.\d{3}-\d)/;

/**
 * Reescribe cifras para Aura. No toca versiones (1.2.3) ni NITs.
 * Enteros de 1–3 dígitos se quedan: Aura los lee bien y «hay 3» suena natural.
 */
export function figuresForTts(text: string): string {
  const token =
    /(?:\$\s*)?-?\d{1,3}(?:[.,]\d{3})*(?:[.,]\d+)?%?(?!\d)|\b(?:USD|COP)\s*-?\d{1,3}(?:[.,]\d{3})*(?:[.,]\d+)?(?!\d)|\d{1,3}(?:[.,]\d{3})*(?:[.,]\d+)?\s*(?:USD|COP|pesos?|d[oó]lares?)%?(?!\d)|\d+%(?!\d)|\d{4,6}(?!\d)/gi;
  return text.replace(token, (raw, offset: number, whole: string) => {
    const trimmed = raw.trim();
    if (SKIP.test(trimmed)) return raw;
    const after = whole.slice(offset + raw.length).trimStart();
    if (SKIP.test(trimmed + after.slice(0, 2))) return raw;
    if (/^\.\d/.test(after)) return raw;
    const before = whole.slice(Math.max(0, offset - 1), offset);
    if (before === '/' || after.startsWith('/')) return raw;
    const parsed = parseFigure(trimmed);
    if (!parsed) return raw;
    const ungrouped = /^\d+$/.test(trimmed.replace(/%$/, ''));
    if (ungrouped && parsed.int < 1000 && !parsed.percent && !parsed.currency && !parsed.frac) {
      return raw;
    }
    if (ungrouped && String(parsed.int).length >= 7) return raw;
    const followed = UNIT_AFTER.test(after);
    return spokenFigure(parsed, followed);
  });
}
