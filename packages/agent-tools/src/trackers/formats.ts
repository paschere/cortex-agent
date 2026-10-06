/**
 * Formatos que un campo de texto puede exigir (`format`) y el regex propio
 * (`pattern`).
 *
 * Archivo hoja, sin dependencias: lo importan el esquema (para rechazar un
 * patrón peligroso al definir la tabla), la validación del servidor y el
 * formulario del navegador. Que sea el MISMO código en los dos lados es lo que
 * evita que la pantalla diga «bien» y el servidor «mal».
 */

export const FIELD_FORMATS = ['email', 'phone', 'nit', 'plate', 'awb', 'digits'] as const;
export type FieldFormat = (typeof FIELD_FORMATS)[number];

export const FORMAT_LABEL: Record<FieldFormat, string> = {
  email: 'un correo electrónico',
  phone: 'un teléfono',
  nit: 'un NIT con dígito de verificación (ej. 900123456-7)',
  plate: 'una placa (ej. ABC123 o ABC12D)',
  awb: 'una guía aérea (ej. 176-12345675)',
  digits: 'solo números',
};

/** Largo máximo de un patrón propio y del texto contra el que se prueba. */
export const PATTERN_MAX = 200;
export const PATTERN_INPUT_MAX = 400;

/** Pesos oficiales de la DIAN, de la cifra de más a la derecha hacia la izquierda. */
const NIT_WEIGHTS = [3, 7, 13, 17, 19, 23, 29, 37, 41, 43, 47, 53, 59, 67, 71];

/** Dígito de verificación de un NIT colombiano (la base, sin el DV). */
export function nitCheckDigit(base: string): number {
  let sum = 0;
  const digits = base.split('').reverse();
  for (const [i, d] of digits.entries()) sum += Number(d) * (NIT_WEIGHTS[i] ?? 0);
  const r = sum % 11;
  return r > 1 ? 11 - r : r;
}

/** «900.123.456-7» o «9001234567» → `{ base, dv }`; null si no tiene la forma. */
function splitNit(value: string): { base: string; dv: number } | null {
  const t = value.replace(/[\s.]/g, '');
  let base: string;
  let dv: string;
  if (t.includes('-')) {
    const parts = t.split('-');
    if (parts.length !== 2) return null;
    base = parts[0] ?? '';
    dv = parts[1] ?? '';
  } else {
    base = t.slice(0, -1);
    dv = t.slice(-1);
  }
  if (!/^\d{6,10}$/.test(base) || !/^\d$/.test(dv)) return null;
  return { base, dv: Number(dv) };
}

export function isValidNit(value: string): boolean {
  const n = splitNit(value);
  return n !== null && nitCheckDigit(n.base) === n.dv;
}

/** Placa colombiana: carro ABC123, moto ABC12D, remolque R12345. */
const PLATE_RE = /^([A-Z]{3}\d{3}|[A-Z]{3}\d{2}[A-Z]|[RS]\d{5})$/;

function plateKey(value: string): string {
  return value.toUpperCase().replace(/[\s-]/g, '');
}

/** Guía aérea IATA: prefijo de 3 dígitos + 8 de serie; el último es la serie (7) mod 7. */
function splitAwb(value: string): { prefix: string; serial: string } | null {
  const m = /^(\d{3})[\s-]?(\d{8})$/.exec(value.trim());
  return m ? { prefix: m[1] as string, serial: m[2] as string } : null;
}

export function isValidAwb(value: string): boolean {
  const a = splitAwb(value);
  if (!a) return false;
  return Number(a.serial.slice(0, 7)) % 7 === Number(a.serial.slice(7));
}

export function checkFormat(format: FieldFormat, value: string): boolean {
  switch (format) {
    case 'email':
      return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value);
    case 'phone': {
      if (!/^\+?[\d\s().-]+$/.test(value)) return false;
      const digits = value.replace(/\D/g, '');
      return digits.length >= 7 && digits.length <= 15;
    }
    case 'digits':
      return /^\d+$/.test(value);
    case 'nit':
      return isValidNit(value);
    case 'plate':
      return PLATE_RE.test(plateKey(value));
    case 'awb':
      return isValidAwb(value);
  }
}

/**
 * La forma canónica de lo que cumple el formato (placa en mayúsculas, guía con
 * guion). Lo que NO cumple se devuelve tal cual: el error lo da la validación,
 * no esta función.
 */
export function normalizeFormatted(format: FieldFormat, value: string): string {
  if (!checkFormat(format, value)) return value;
  switch (format) {
    case 'email':
      return value.toLowerCase();
    case 'plate':
      return plateKey(value);
    case 'awb': {
      const a = splitAwb(value);
      return a ? `${a.prefix}-${a.serial}` : value;
    }
    case 'nit': {
      const n = splitNit(value);
      return n ? `${n.base}-${n.dv}` : value;
    }
    default:
      return value.trim();
  }
}

/**
 * ¿Es seguro compilar este patrón? No hay forma de garantizar un regex sin
 * motor propio, así que se rechazan las formas que explotan el retroceso: un
 * cuantificador dentro de un grupo que a su vez se repite —`(a+)+`, `(a*)*`,
 * `(\d{2,})+`—, las referencias hacia atrás y los patrones larguísimos. Además
 * el texto que se prueba se corta a `PATTERN_INPUT_MAX`.
 */
export function isSafePattern(pattern: string): boolean {
  if (!pattern || pattern.length > PATTERN_MAX) return false;
  if (/\\[1-9]|\\k</.test(pattern)) return false;
  // Grupo con cuantificador adentro, repetido por fuera: (...+...)+  (...*...)*  (...{n,}...)+
  if (
    /\((?:[^()\\]|\\.)*(?:[+*]|\{\d+,\d*\})(?:[^()\\]|\\.)*\)\s*(?:[+*]|\{\d+,\d*\})/.test(pattern)
  )
    return false;
  // Lo mismo con un grupo anidado dentro del grupo que se repite.
  if (/\([^()]*\([^()]*(?:[+*]|\{\d+,\d*\})[^()]*\)[^()]*\)\s*(?:[+*]|\{\d+,\d*\})/.test(pattern))
    return false;
  return true;
}

/** Compila el patrón o devuelve null (inseguro o mal escrito). Nunca lanza. */
export function compilePattern(pattern: string): RegExp | null {
  if (!isSafePattern(pattern)) return null;
  try {
    return new RegExp(pattern, 'u');
  } catch {
    return null;
  }
}

export function testPattern(re: RegExp, value: string): boolean {
  return re.test(value.slice(0, PATTERN_INPUT_MAX));
}
