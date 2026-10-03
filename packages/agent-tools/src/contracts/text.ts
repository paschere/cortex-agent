/**
 * Cifras y fechas como se escriben en un contrato colombiano: «doce millones
 * de pesos ($12.000.000)», «treinta (30) días», «1 de octubre de 2026».
 *
 * Puro y sin dependencias; lo usan el llenado de plantillas y la lectura de
 * obligaciones (para reconocer «treinta (30) días» en una cita).
 */

const UNITS = [
  '',
  'un',
  'dos',
  'tres',
  'cuatro',
  'cinco',
  'seis',
  'siete',
  'ocho',
  'nueve',
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
  'veinte',
  'veintiún',
  'veintidós',
  'veintitrés',
  'veinticuatro',
  'veinticinco',
  'veintiséis',
  'veintisiete',
  'veintiocho',
  'veintinueve',
];
const TENS = [
  '',
  '',
  '',
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

function under100(n: number): string {
  if (n < 30) return UNITS[n] as string;
  const t = Math.floor(n / 10);
  const u = n % 10;
  return u ? `${TENS[t]} y ${UNITS[u]}` : (TENS[t] as string);
}

function under1000(n: number): string {
  if (n === 0) return '';
  if (n === 100) return 'cien';
  const h = Math.floor(n / 100);
  const r = n % 100;
  return [HUNDREDS[h], r ? under100(r) : ''].filter(Boolean).join(' ');
}

function underMillion(n: number): string {
  const thousands = Math.floor(n / 1000);
  const rest = n % 1000;
  const head = thousands === 0 ? '' : thousands === 1 ? 'mil' : `${under1000(thousands)} mil`;
  return [head, under1000(rest)].filter(Boolean).join(' ');
}

/**
 * Un entero en letras, con apócope ante sustantivo («un», «veintiún»):
 * 21 000 → «veintiún mil», 1 000 000 → «un millón». Hasta billones.
 */
export function numberToSpanish(value: number): string {
  const n = Math.floor(Math.abs(value));
  if (!Number.isFinite(n)) return '';
  if (n === 0) return 'cero';
  const trillions = Math.floor(n / 1e12);
  const millions = Math.floor((n % 1e12) / 1e6);
  const rest = n % 1e6;
  const parts: string[] = [];
  if (trillions) parts.push(trillions === 1 ? 'un billón' : `${underMillion(trillions)} billones`);
  if (millions) parts.push(millions === 1 ? 'un millón' : `${underMillion(millions)} millones`);
  if (rest) parts.push(underMillion(rest));
  return parts.join(' ');
}

/** «doce millones de pesos m/cte ($12.000.000)». Sin centavos. */
export function pesosInWords(amount: number, currency = 'COP'): string {
  const n = Math.round(Math.abs(amount));
  const digits = n.toLocaleString('es-CO', { maximumFractionDigits: 0 });
  if ((currency || 'COP').toUpperCase() !== 'COP') {
    return `${numberToSpanish(n)} (${digits} ${currency.toUpperCase()})`;
  }
  const words = numberToSpanish(n);
  const exactMillions = n >= 1e6 && n % 1e6 === 0;
  const noun = n === 1 ? 'peso' : 'pesos';
  return `${words} ${exactMillions ? 'de ' : ''}${noun} m/cte ($${digits})`;
}

/** «treinta (30) días». */
export function countInWords(n: number, one: string, many: string): string {
  return `${numberToSpanish(n)} (${n}) ${n === 1 ? one : many}`;
}

const MONTHS = [
  'enero',
  'febrero',
  'marzo',
  'abril',
  'mayo',
  'junio',
  'julio',
  'agosto',
  'septiembre',
  'octubre',
  'noviembre',
  'diciembre',
];

/** `2026-10-01` → «1 de octubre de 2026». Lo que no es una fecha sale igual. */
export function longSpanishDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
  if (!m) return iso;
  const month = MONTHS[Number(m[2]) - 1];
  if (!month) return iso;
  return `${Number(m[3])} de ${month} de ${m[1]}`;
}

/** Sin tildes, minúsculas, espacios simples: para comparar palabras. */
export function foldText(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
}
