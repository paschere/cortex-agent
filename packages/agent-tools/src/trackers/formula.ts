import { type TrmTable, ambientTrm, trmOn, trmWarning } from './trm';
/**
 * EL EVALUADOR DE FÓRMULAS DE LAS TABLAS.
 *
 * Un campo calculado (`formula` en la configuración del campo) se escribe como
 * en una hoja de cálculo: «[Kilos] × [Tarifa]», «si([Saldo] > 0; "Debe"; "Al día")»,
 * «dias_entre([Fecha]; hoy())». Este módulo es el parser y el evaluador.
 *
 * Es PURO y propio, a propósito:
 *   - nada de eval ni de `new Function`: el texto se vuelve un árbol y el árbol
 *     se recorre; lo único que puede hacer una fórmula es lo que está en la tabla
 *     de funciones de abajo;
 *   - cero importaciones: lo corren igual el navegador (al instante, en el
 *     formulario) y el servidor (al guardar), y se puede importar desde un
 *     componente de cliente sin arrastrar el barril de @cortex/agent-tools;
 *   - sin reloj propio: «hoy()» sale del contexto (`today`/`now`, hora de Bogotá).
 *
 * SINTAXIS
 *   Campos       [Nombre visible] o [clave]; una clave sin corchetes (kilos) también.
 *   Números      1234.5 · 1,5 (coma decimal) · 1.234.567,89 (puntos de miles) · 20%
 *   Textos       "entre comillas" o 'simples'
 *   Operadores   + − × ÷ (o + - * /), ^ potencia, & une textos, % al final = ÷100,
 *                comparaciones = <> != < <= > >=
 *   Argumentos   se separan con «;» (o con «, » coma y espacio). «1,5» es UN
 *                número con coma decimal, no dos argumentos.
 *   Precedencia  paréntesis > % > ^ > − unario > × ÷ > + − > & > comparaciones.
 *                (−2^2 = −4; la potencia se asocia por la derecha.)
 *
 * SEMÁNTICA
 *   - Un campo vacío en una operación aritmética deja el resultado vacío (la
 *     fórmula «espera» a que lo llenen); no cuenta como 0. Funciones como suma,
 *     concatenar, si, y/o y vacio() sí lo tratan como «nada».
 *   - División entre cero (÷, residuo, raiz de negativo…) → vacío, con aviso.
 *   - Fecha − fecha = días; fecha ± número = fecha desplazada esos días.
 *   - Un texto que parece número («1.250,50») se lee como número en cuentas.
 */

// ---------------------------------------------------------------------------
// Valores
// ---------------------------------------------------------------------------

export interface FDate {
  k: 'date';
  /** Milisegundos desde 1970 de la hora de pared (Bogotá) leída como UTC. */
  ms: number;
  /** ¿Trae hora? Una fecha sola es medianoche. */
  time: boolean;
}
export interface FTime {
  k: 'time';
  /** Minutos desde la medianoche. */
  min: number;
}
export type FVal = number | string | boolean | null | FDate | FTime;

const DAY_MS = 86_400_000;

export const isFDate = (v: unknown): v is FDate =>
  typeof v === 'object' && v !== null && (v as FDate).k === 'date';
export const isFTime = (v: unknown): v is FTime =>
  typeof v === 'object' && v !== null && (v as FTime).k === 'time';

/** «2026-10-16» (opcional «T»/espacio + «HH:MM») → fecha; null si no lo es. */
export function parseDateText(text: string): FDate | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(text.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const ms = Date.UTC(y, mo - 1, d, m[4] ? Number(m[4]) : 0, m[5] ? Number(m[5]) : 0);
  const check = new Date(ms);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d)
    return null;
  return { k: 'date', ms, time: Boolean(m[4]) };
}

/** «HH:MM» → hora del día; null si no lo es. */
export function parseTimeText(text: string): FTime | null {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(text.trim());
  return m ? { k: 'time', min: Number(m[1]) * 60 + Number(m[2]) } : null;
}

const p2 = (n: number) => String(n).padStart(2, '0');

/** Fecha → «YYYY-MM-DD». */
export function dateIso(d: FDate): string {
  const x = new Date(d.ms);
  return `${x.getUTCFullYear()}-${p2(x.getUTCMonth() + 1)}-${p2(x.getUTCDate())}`;
}
/** Hora de pared de una fecha → «HH:MM». */
export function dateClock(d: FDate): string {
  const x = new Date(d.ms);
  return `${p2(x.getUTCHours())}:${p2(x.getUTCMinutes())}`;
}
export function timeClock(t: FTime): string {
  const m = ((Math.round(t.min) % 1440) + 1440) % 1440;
  return `${p2(Math.floor(m / 60))}:${p2(m % 60)}`;
}

/** Redondeo «de colegio» (0,5 sube, también en 1,005) a `dec` decimales. */
export function roundTo(x: number, dec = 0): number {
  if (!Number.isFinite(x)) return x;
  const abs = Math.abs(x);
  const sign = x < 0 ? -1 : 1;
  if (abs < 1e-6 || abs >= 1e15 || dec < 0 || dec > 12) {
    const f = 10 ** Math.max(0, Math.min(dec, 12));
    return (sign * Math.round(abs * f)) / f;
  }
  return sign * Number(`${Math.round(Number(`${abs}e${dec}`))}e-${dec}`);
}

/** Un número como texto en es-CO: coma decimal, sin separador de miles, hasta 6 decimales. */
export function numberText(n: number): string {
  if (!Number.isFinite(n)) return '';
  return String(roundTo(n, 6)).replace('.', ',');
}

/** El valor como texto para unirlo con otros (concatenar, &, texto()). */
export function textOf(v: FVal): string {
  if (v === null) return '';
  if (typeof v === 'number') return numberText(v);
  if (typeof v === 'boolean') return v ? 'Sí' : 'No';
  if (typeof v === 'string') return v;
  if (isFTime(v)) return timeClock(v);
  return v.time ? `${dateIso(v)} ${dateClock(v)}` : dateIso(v);
}

/** Un texto que parece un número (colombiano o no) → número; null si no. */
export function parseLooseNumber(raw: string): number | null {
  const t = raw.trim().replace(/^\$\s*/, '');
  if (!t) return null;
  // Igual que en las fórmulas: 1.500 son mil quinientos (puntos de miles), 1.5 y 0.500 son decimales.
  if (/^-?[1-9]\d{0,2}(\.\d{3})+(,\d+)?$/.test(t))
    return Number(t.replace(/\./g, '').replace(',', '.'));
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if (/^-?\d+,\d+$/.test(t)) return Number(t.replace(',', '.'));
  if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) return Number(t.replace(/,/g, ''));
  return null;
}

const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();

// ---------------------------------------------------------------------------
// Árbol
// ---------------------------------------------------------------------------

export type FNode =
  | { t: 'num'; v: number }
  | { t: 'str'; v: string }
  | { t: 'bool'; v: boolean }
  | { t: 'ref'; name: string; at: number }
  | { t: 'un'; op: '-' | '+'; x: FNode }
  | { t: 'pct'; x: FNode }
  | { t: 'bin'; op: string; l: FNode; r: FNode; at: number }
  | { t: 'call'; fn: string; args: FNode[]; at: number };

export interface ParsedFormula {
  ast: FNode;
  /** Los campos que la fórmula nombra (texto tal cual, sin repetir). */
  refs: string[];
}

export type ParseResult =
  | { ok: true; formula: ParsedFormula }
  | { ok: false; message: string; at: number };

export const FORMULA_MAX = 500;
const MAX_DEPTH = 40;
const MAX_NODES = 300;

// ---------------------------------------------------------------------------
// Funciones: nombre (sin tildes), aridad y alias
// ---------------------------------------------------------------------------

interface FnSpec {
  min: number;
  max: number;
}

const FN_SPECS: Record<string, FnSpec> = {
  redondear: { min: 1, max: 2 },
  redondear_mas: { min: 1, max: 2 },
  redondear_menos: { min: 1, max: 2 },
  entero: { min: 1, max: 1 },
  abs: { min: 1, max: 1 },
  min: { min: 1, max: 40 },
  max: { min: 1, max: 40 },
  suma: { min: 1, max: 40 },
  promedio: { min: 1, max: 40 },
  raiz: { min: 1, max: 1 },
  potencia: { min: 2, max: 2 },
  residuo: { min: 2, max: 2 },
  si: { min: 3, max: 3 },
  si_error: { min: 2, max: 2 },
  y: { min: 1, max: 40 },
  o: { min: 1, max: 40 },
  no: { min: 1, max: 1 },
  vacio: { min: 1, max: 1 },
  concatenar: { min: 1, max: 40 },
  unir: { min: 2, max: 40 },
  texto: { min: 1, max: 2 },
  numero: { min: 1, max: 1 },
  mayusculas: { min: 1, max: 1 },
  minusculas: { min: 1, max: 1 },
  largo: { min: 1, max: 1 },
  izquierda: { min: 2, max: 2 },
  derecha: { min: 2, max: 2 },
  recortar: { min: 1, max: 1 },
  reemplazar: { min: 3, max: 3 },
  contiene: { min: 2, max: 2 },
  hoy: { min: 0, max: 0 },
  trm: { min: 0, max: 1 },
  ahora: { min: 0, max: 0 },
  fecha: { min: 3, max: 3 },
  fecha_hora: { min: 2, max: 2 },
  dias_entre: { min: 2, max: 2 },
  horas_entre: { min: 2, max: 2 },
  minutos_entre: { min: 2, max: 2 },
  ano: { min: 1, max: 1 },
  mes: { min: 1, max: 1 },
  dia: { min: 1, max: 1 },
  dia_semana: { min: 1, max: 1 },
  hora: { min: 1, max: 1 },
  minuto: { min: 1, max: 1 },
  sumar_dias: { min: 2, max: 2 },
  sumar_meses: { min: 2, max: 2 },
  fin_de_mes: { min: 1, max: 1 },
};

const FN_ALIASES: Record<string, string> = {
  anio: 'ano',
  year: 'ano',
  month: 'mes',
  day: 'dia',
  round: 'redondear',
  roundup: 'redondear_mas',
  rounddown: 'redondear_menos',
  techo: 'redondear_mas',
  piso: 'redondear_menos',
  int: 'entero',
  sum: 'suma',
  avg: 'promedio',
  average: 'promedio',
  sqrt: 'raiz',
  power: 'potencia',
  mod: 'residuo',
  if: 'si',
  iferror: 'si_error',
  and: 'y',
  or: 'o',
  not: 'no',
  isblank: 'vacio',
  esvacio: 'vacio',
  es_vacio: 'vacio',
  concat: 'concatenar',
  join: 'unir',
  text: 'texto',
  number: 'numero',
  upper: 'mayusculas',
  lower: 'minusculas',
  len: 'largo',
  left: 'izquierda',
  right: 'derecha',
  trim: 'recortar',
  replace: 'reemplazar',
  contains: 'contiene',
  today: 'hoy',
  official_trm: 'trm',
  now: 'ahora',
  date: 'fecha',
  days_between: 'dias_entre',
  hours_between: 'horas_entre',
  minutes_between: 'minutos_entre',
  add_days: 'sumar_dias',
  add_months: 'sumar_meses',
  eomonth: 'fin_de_mes',
  weekday: 'dia_semana',
};

/** Los nombres de función que se anuncian al modelo y al autocompletado. */
export const FORMULA_FUNCTIONS: Array<{ name: string; usage: string; help: string }> = [
  { name: 'redondear', usage: 'redondear(x; decimales)', help: 'Redondea (0,5 sube).' },
  { name: 'redondear_mas', usage: 'redondear_mas(x; decimales)', help: 'Redondea hacia arriba.' },
  {
    name: 'redondear_menos',
    usage: 'redondear_menos(x; decimales)',
    help: 'Redondea hacia abajo.',
  },
  { name: 'entero', usage: 'entero(x)', help: 'Parte entera (hacia abajo).' },
  { name: 'abs', usage: 'abs(x)', help: 'Valor absoluto.' },
  { name: 'min', usage: 'min(a; b; …)', help: 'El menor (ignora vacíos).' },
  { name: 'max', usage: 'max(a; b; …)', help: 'El mayor (ignora vacíos).' },
  { name: 'suma', usage: 'suma(a; b; …)', help: 'Suma ignorando los vacíos.' },
  { name: 'promedio', usage: 'promedio(a; b; …)', help: 'Promedio ignorando los vacíos.' },
  { name: 'raiz', usage: 'raiz(x)', help: 'Raíz cuadrada.' },
  { name: 'potencia', usage: 'potencia(base; exponente)', help: 'Potencia (también a ^ b).' },
  { name: 'residuo', usage: 'residuo(a; b)', help: 'Resto de a ÷ b.' },
  { name: 'si', usage: 'si(condición; si_cierto; si_falso)', help: 'Elige según la condición.' },
  {
    name: 'si_error',
    usage: 'si_error(valor; alternativa)',
    help: 'La alternativa si el valor no se pudo calcular.',
  },
  { name: 'y', usage: 'y(a; b; …)', help: 'Cierto si todas lo son.' },
  { name: 'o', usage: 'o(a; b; …)', help: 'Cierto si alguna lo es.' },
  { name: 'no', usage: 'no(a)', help: 'Invierte cierto/falso.' },
  { name: 'vacio', usage: 'vacio(campo)', help: 'Cierto si el campo no tiene nada.' },
  { name: 'concatenar', usage: 'concatenar(a; b; …)', help: 'Une textos.' },
  {
    name: 'unir',
    usage: 'unir(separador; a; b; …)',
    help: 'Une textos con un separador, saltando los vacíos.',
  },
  { name: 'texto', usage: 'texto(x; decimales)', help: 'Convierte a texto.' },
  { name: 'numero', usage: 'numero(texto)', help: 'Convierte un texto a número.' },
  { name: 'mayusculas', usage: 'mayusculas(t)', help: 'Todo en mayúsculas.' },
  { name: 'minusculas', usage: 'minusculas(t)', help: 'Todo en minúsculas.' },
  { name: 'largo', usage: 'largo(t)', help: 'Cantidad de caracteres.' },
  { name: 'izquierda', usage: 'izquierda(t; n)', help: 'Los primeros n caracteres.' },
  { name: 'derecha', usage: 'derecha(t; n)', help: 'Los últimos n caracteres.' },
  { name: 'recortar', usage: 'recortar(t)', help: 'Quita espacios de los lados.' },
  { name: 'reemplazar', usage: 'reemplazar(t; buscar; nuevo)', help: 'Cambia un texto por otro.' },
  { name: 'contiene', usage: 'contiene(t; buscar)', help: 'Cierto si t incluye lo buscado.' },
  { name: 'hoy', usage: 'hoy()', help: 'La fecha de hoy.' },
  {
    name: 'trm',
    usage: 'trm([fecha])',
    help: 'TRM oficial (pesos por dólar) que rige ese día, fines de semana y festivos incluidos; sin fecha, la de hoy.',
  },
  { name: 'ahora', usage: 'ahora()', help: 'La fecha y hora de ahora.' },
  { name: 'fecha', usage: 'fecha(año; mes; día)', help: 'Arma una fecha.' },
  { name: 'fecha_hora', usage: 'fecha_hora(fecha; hora)', help: 'Junta una fecha y una hora.' },
  {
    name: 'dias_entre',
    usage: 'dias_entre(desde; hasta)',
    help: 'Días de calendario de una fecha a otra.',
  },
  {
    name: 'horas_entre',
    usage: 'horas_entre(desde; hasta)',
    help: 'Horas entre dos fechas/horas.',
  },
  {
    name: 'minutos_entre',
    usage: 'minutos_entre(desde; hasta)',
    help: 'Minutos entre dos fechas/horas.',
  },
  { name: 'año', usage: 'año(fecha)', help: 'El año de una fecha.' },
  { name: 'mes', usage: 'mes(fecha)', help: 'El mes (1 a 12).' },
  { name: 'dia', usage: 'dia(fecha)', help: 'El día del mes.' },
  { name: 'dia_semana', usage: 'dia_semana(fecha)', help: '1 = lunes … 7 = domingo.' },
  { name: 'hora', usage: 'hora(hora_o_fecha)', help: 'La hora (0 a 23).' },
  { name: 'minuto', usage: 'minuto(hora_o_fecha)', help: 'Los minutos (0 a 59).' },
  { name: 'sumar_dias', usage: 'sumar_dias(fecha; n)', help: 'Suma n días a una fecha.' },
  { name: 'sumar_meses', usage: 'sumar_meses(fecha; n)', help: 'Suma n meses a una fecha.' },
  { name: 'fin_de_mes', usage: 'fin_de_mes(fecha)', help: 'El último día del mes de la fecha.' },
];

function canonicalFn(raw: string): string | null {
  const f = fold(raw);
  if (FN_SPECS[f]) return f;
  const alias = FN_ALIASES[f];
  return alias && FN_SPECS[alias] ? alias : null;
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

type Tok =
  | { k: 'num'; v: number; at: number }
  | { k: 'str'; v: string; at: number }
  | { k: 'ref'; v: string; at: number }
  | { k: 'id'; v: string; at: number }
  | { k: 'op'; v: string; at: number }
  | { k: 'sep'; at: number }
  | { k: '('; at: number }
  | { k: ')'; at: number }
  | { k: 'end'; at: number };

class FormulaSyntaxError extends Error {
  constructor(
    message: string,
    readonly at: number,
  ) {
    super(message);
  }
}

const THOUSANDS_RE = /^[1-9]\d{0,2}(?:\.\d{3})+(?:,\d+)?(?![\d])/;
const PLAIN_RE = /^\d+(?:[.,]\d+)?/;

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i] as string;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (/\d/.test(c)) {
      const rest = src.slice(i);
      const th = THOUSANDS_RE.exec(rest);
      const m = th ?? PLAIN_RE.exec(rest);
      if (!m) throw new FormulaSyntaxError('Número mal escrito.', i);
      const text = m[0];
      const v = th
        ? Number(text.replace(/\./g, '').replace(',', '.'))
        : Number(text.replace(',', '.'));
      out.push({ k: 'num', v, at: i });
      i += text.length;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      let s = '';
      while (j < src.length && src[j] !== c) {
        s += src[j];
        j++;
      }
      if (j >= src.length)
        throw new FormulaSyntaxError(`Falta cerrar las comillas (${c}) de un texto.`, i);
      out.push({ k: 'str', v: s, at: i });
      i = j + 1;
      continue;
    }
    if (c === '[') {
      const j = src.indexOf(']', i + 1);
      if (j < 0) throw new FormulaSyntaxError('Falta cerrar un corchete «]».', i);
      const name = src.slice(i + 1, j).trim();
      if (!name) throw new FormulaSyntaxError('Hay un campo vacío entre corchetes «[]».', i);
      if (name.length > 80) throw new FormulaSyntaxError('Nombre de campo demasiado largo.', i);
      out.push({ k: 'ref', v: name, at: i });
      i = j + 1;
      continue;
    }
    if (/[\p{L}_]/u.test(c)) {
      let j = i + 1;
      while (j < src.length && /[\p{L}\p{N}_]/u.test(src[j] as string)) j++;
      out.push({ k: 'id', v: src.slice(i, j), at: i });
      i = j;
      continue;
    }
    if (c === '(') {
      out.push({ k: '(', at: i });
      i++;
      continue;
    }
    if (c === ')') {
      out.push({ k: ')', at: i });
      i++;
      continue;
    }
    if (c === ';') {
      out.push({ k: 'sep', at: i });
      i++;
      continue;
    }
    if (c === ',') {
      // «a, b» (coma y espacio) separa argumentos; «1,5» ya se leyó como número.
      out.push({ k: 'sep', at: i });
      i++;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (two === '<=' || two === '>=' || two === '<>' || two === '!=' || two === '==') {
      out.push({ k: 'op', v: two === '==' ? '=' : two === '!=' ? '<>' : two, at: i });
      i += 2;
      continue;
    }
    if ('+-−*×/÷^&=<>%'.includes(c)) {
      const v = c === '−' ? '-' : c === '×' ? '*' : c === '÷' ? '/' : c;
      out.push({ k: 'op', v, at: i });
      i++;
      continue;
    }
    throw new FormulaSyntaxError(`No entiendo el símbolo «${c}».`, i);
  }
  out.push({ k: 'end', at: src.length });
  return out;
}

// ---------------------------------------------------------------------------
// Parser (descenso recursivo)
// ---------------------------------------------------------------------------

class Parser {
  private p = 0;
  private nodes = 0;
  readonly refs = new Set<string>();
  constructor(private readonly toks: Tok[]) {}

  private peek(): Tok {
    return this.toks[this.p] as Tok;
  }
  private next(): Tok {
    return this.toks[this.p++] as Tok;
  }
  private bump(depth: number) {
    this.nodes++;
    if (this.nodes > MAX_NODES) throw new FormulaSyntaxError('La fórmula es demasiado larga.', 0);
    if (depth > MAX_DEPTH)
      throw new FormulaSyntaxError('Demasiados paréntesis anidados.', this.peek().at);
  }

  parseAll(): FNode {
    if (this.peek().k === 'end') throw new FormulaSyntaxError('La fórmula está vacía.', 0);
    const n = this.comparison(0);
    const t = this.peek();
    if (t.k !== 'end') {
      if (t.k === ')') throw new FormulaSyntaxError('Sobra un paréntesis de cierre «)».', t.at);
      if (t.k === 'sep')
        throw new FormulaSyntaxError(
          'Una coma o «;» sólo va entre los argumentos de una función. Para un decimal usa 1,5 o 1.5.',
          t.at,
        );
      throw new FormulaSyntaxError('Falta un operador (+ − × ÷) entre dos valores.', t.at);
    }
    return n;
  }

  private comparison(d: number): FNode {
    let l = this.concat(d);
    for (;;) {
      const t = this.peek();
      if (t.k === 'op' && ['=', '<>', '<', '<=', '>', '>='].includes(t.v)) {
        this.next();
        const r = this.concat(d);
        this.bump(d);
        l = { t: 'bin', op: t.v, l, r, at: t.at };
      } else return l;
    }
  }

  private concat(d: number): FNode {
    let l = this.additive(d);
    for (;;) {
      const t = this.peek();
      if (t.k === 'op' && t.v === '&') {
        this.next();
        const r = this.additive(d);
        this.bump(d);
        l = { t: 'bin', op: '&', l, r, at: t.at };
      } else return l;
    }
  }

  private additive(d: number): FNode {
    let l = this.term(d);
    for (;;) {
      const t = this.peek();
      if (t.k === 'op' && (t.v === '+' || t.v === '-')) {
        this.next();
        const r = this.term(d);
        this.bump(d);
        l = { t: 'bin', op: t.v, l, r, at: t.at };
      } else return l;
    }
  }

  private term(d: number): FNode {
    let l = this.unary(d);
    for (;;) {
      const t = this.peek();
      if (t.k === 'op' && (t.v === '*' || t.v === '/')) {
        this.next();
        const r = this.unary(d);
        this.bump(d);
        l = { t: 'bin', op: t.v, l, r, at: t.at };
      } else return l;
    }
  }

  private unary(d: number): FNode {
    const t = this.peek();
    if (t.k === 'op' && (t.v === '-' || t.v === '+')) {
      this.next();
      this.bump(d);
      return { t: 'un', op: t.v, x: this.unary(d + 1) };
    }
    return this.power(d);
  }

  private power(d: number): FNode {
    const base = this.postfix(d);
    const t = this.peek();
    if (t.k === 'op' && t.v === '^') {
      this.next();
      // Asociativa por la derecha; el exponente puede llevar signo: 2^-1.
      const exp = this.powerOperand(d + 1);
      this.bump(d);
      return { t: 'bin', op: '^', l: base, r: exp, at: t.at };
    }
    return base;
  }

  private powerOperand(d: number): FNode {
    const t = this.peek();
    if (t.k === 'op' && (t.v === '-' || t.v === '+')) {
      this.next();
      this.bump(d);
      return { t: 'un', op: t.v, x: this.powerOperand(d + 1) };
    }
    return this.power(d);
  }

  private postfix(d: number): FNode {
    let n = this.primary(d);
    while (this.peek().k === 'op' && (this.peek() as { v: string }).v === '%') {
      this.next();
      this.bump(d);
      n = { t: 'pct', x: n };
    }
    return n;
  }

  private primary(d: number): FNode {
    const t = this.next();
    this.bump(d);
    switch (t.k) {
      case 'num':
        return { t: 'num', v: t.v };
      case 'str':
        return { t: 'str', v: t.v };
      case 'ref':
        this.refs.add(t.v);
        return { t: 'ref', name: t.v, at: t.at };
      case '(': {
        if (this.peek().k === ')')
          throw new FormulaSyntaxError('Hay unos paréntesis vacíos «()».', t.at);
        const inner = this.comparison(d + 1);
        const close = this.next();
        if (close.k !== ')') throw new FormulaSyntaxError('Falta cerrar un paréntesis «)».', t.at);
        return inner;
      }
      case 'id': {
        if (this.peek().k === '(') {
          this.next();
          const fn = canonicalFn(t.v);
          if (!fn)
            throw new FormulaSyntaxError(
              `No conozco la función «${t.v}». Las que hay: ${FORMULA_FUNCTIONS.map((f) => f.name).join(', ')}.`,
              t.at,
            );
          const args: FNode[] = [];
          if (this.peek().k === ')') this.next();
          else
            for (;;) {
              args.push(this.comparison(d + 1));
              const s = this.next();
              if (s.k === ')') break;
              if (s.k !== 'sep')
                throw new FormulaSyntaxError(`Falta cerrar el paréntesis de «${t.v}(».`, t.at);
            }
          const spec = FN_SPECS[fn] as FnSpec;
          if (args.length < spec.min || args.length > spec.max)
            throw new FormulaSyntaxError(
              spec.min === spec.max
                ? `«${t.v}» recibe ${spec.min} valor${spec.min === 1 ? '' : 'es'} y le pusiste ${args.length}. Separa los argumentos con «;» (el «1,5» es un solo número).`
                : `«${t.v}» recibe de ${spec.min} a ${spec.max} valores y le pusiste ${args.length}. Separa los argumentos con «;».`,
              t.at,
            );
          return { t: 'call', fn, args, at: t.at };
        }
        const lower = fold(t.v);
        if (lower === 'verdadero' || lower === 'true') return { t: 'bool', v: true };
        if (lower === 'falso' || lower === 'false') return { t: 'bool', v: false };
        this.refs.add(t.v);
        return { t: 'ref', name: t.v, at: t.at };
      }
      case 'end':
        throw new FormulaSyntaxError('La fórmula termina antes de tiempo: falta un valor.', t.at);
      case 'sep':
        throw new FormulaSyntaxError('Falta un valor antes de la coma o el «;».', t.at);
      case ')':
        throw new FormulaSyntaxError('Sobra un paréntesis de cierre «)».', t.at);
      case 'op':
        throw new FormulaSyntaxError(`Falta un valor antes de «${t.v}».`, t.at);
    }
  }
}

const parseCache = new Map<string, ParseResult>();

/** Lee el texto de una fórmula. Nunca lanza: devuelve el error en español y dónde está. */
export function parseFormula(source: string): ParseResult {
  const cached = parseCache.get(source);
  if (cached) return cached;
  let result: ParseResult;
  const src = source.replace(/^\s*=/, '');
  if (source.length > FORMULA_MAX) {
    result = { ok: false, message: `La fórmula pasa de ${FORMULA_MAX} caracteres.`, at: 0 };
  } else {
    try {
      const parser = new Parser(tokenize(src));
      const ast = parser.parseAll();
      result = { ok: true, formula: { ast, refs: [...parser.refs] } };
    } catch (err) {
      if (err instanceof FormulaSyntaxError)
        result = { ok: false, message: err.message, at: err.at };
      else result = { ok: false, message: 'No pude leer la fórmula.', at: 0 };
    }
  }
  if (parseCache.size > 500) parseCache.clear();
  parseCache.set(source, result);
  return result;
}

// ---------------------------------------------------------------------------
// Evaluador
// ---------------------------------------------------------------------------

export interface FormulaContext {
  /** El valor del campo nombrado; `undefined` = ese campo no existe. */
  get: (name: string) => FVal | undefined;
  /** «YYYY-MM-DD» de hoy (Bogotá). */
  today: string;
  /** «HH:MM» de ahora (Bogotá). */
  now: string;
  /** TRM oficial para `trm()`; si falta se usa la tabla ambiente que carga el servidor. */
  trm?: TrmTable;
}

export interface FormulaResult {
  /** `null` = vacío (falta un dato, división por cero o error). */
  value: FVal;
  /** Avisos que no tumban la fila: «No se puede dividir entre cero.» */
  warnings: string[];
  /** Un fallo que dejó el resultado vacío (texto donde iba un número, etc.). */
  error?: string;
}

class RuntimeError extends Error {}

class Run {
  warnings: string[] = [];
  constructor(readonly ctx: FormulaContext) {}

  warn(m: string) {
    if (!this.warnings.includes(m)) this.warnings.push(m);
  }

  /** Un valor como número, o falla nombrando de dónde vino. */
  num(v: FVal, n: FNode): number | null {
    if (v === null) return null;
    if (typeof v === 'number') return v;
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (typeof v === 'string') {
      if (v.trim() === '') return null;
      const x = parseLooseNumber(v);
      if (x === null) throw new RuntimeError(`${label(n)} no es un número («${v.slice(0, 30)}»).`);
      return x;
    }
    throw new RuntimeError(`${label(n)} es una fecha u hora, no un número.`);
  }

  /** Verdadero/falso de una condición. */
  truthy(v: FVal, n: FNode): boolean {
    if (v === null) return false;
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return v !== 0;
    if (typeof v === 'string') {
      const t = fold(v);
      if (['si', 'true', 'verdadero', '1', 'x', 'yes'].includes(t)) return true;
      if (['no', 'false', 'falso', '0', '', 'off'].includes(t)) return false;
      throw new RuntimeError(`${label(n)} («${v.slice(0, 30)}») no es cierto ni falso.`);
    }
    throw new RuntimeError(`${label(n)} no es una condición.`);
  }

  date(v: FVal, n: FNode): FDate | null {
    if (v === null) return null;
    if (isFDate(v)) return v;
    if (typeof v === 'string') {
      const d = parseDateText(v);
      if (d) return d;
    }
    throw new RuntimeError(`${label(n)} no es una fecha.`);
  }

  /** Para horas_entre y similares: fecha con hora o solo hora, en minutos. */
  minutesOf(v: FVal, n: FNode): { abs: boolean; v: number } | null {
    if (v === null) return null;
    if (isFTime(v)) return { abs: false, v: v.min };
    if (isFDate(v)) return { abs: true, v: v.ms / 60_000 };
    if (typeof v === 'string') {
      const d = parseDateText(v);
      if (d) return { abs: true, v: d.ms / 60_000 };
      const t = parseTimeText(v);
      if (t) return { abs: false, v: t.min };
    }
    throw new RuntimeError(`${label(n)} no es una fecha ni una hora.`);
  }

  ev(n: FNode): FVal {
    switch (n.t) {
      case 'num':
        return n.v;
      case 'str':
        return n.v;
      case 'bool':
        return n.v;
      case 'ref': {
        const v = this.ctx.get(n.name);
        if (v === undefined) throw new RuntimeError(`No existe el campo «${n.name}».`);
        return v;
      }
      case 'un': {
        const x = this.ev(n.x);
        const num = this.num(x, n.x);
        if (num === null) return null;
        return n.op === '-' ? -num : num;
      }
      case 'pct': {
        const num = this.num(this.ev(n.x), n.x);
        return num === null ? null : num / 100;
      }
      case 'bin':
        return this.bin(n);
      case 'call':
        return this.call(n);
    }
  }

  private bin(n: Extract<FNode, { t: 'bin' }>): FVal {
    const a = this.ev(n.l);
    const b = this.ev(n.r);
    switch (n.op) {
      case '&':
        return textOf(a) + textOf(b);
      case '=':
      case '<>':
      case '<':
      case '<=':
      case '>':
      case '>=':
        return this.compare(n.op, a, b);
    }
    // Aritmética con fechas y horas.
    if (isFDate(a) || isFDate(b) || isFTime(a) || isFTime(b)) {
      if (n.op === '-' && isFDate(a) && isFDate(b)) return (a.ms - b.ms) / DAY_MS;
      if (n.op === '-' && isFTime(a) && isFTime(b)) return (a.min - b.min) / 60;
      if ((n.op === '+' || n.op === '-') && isFDate(a)) {
        const d = this.num(b, n.r);
        return d === null ? null : { ...a, ms: a.ms + (n.op === '-' ? -d : d) * DAY_MS };
      }
      if (n.op === '+' && isFDate(b)) {
        const d = this.num(a, n.l);
        return d === null ? null : { ...b, ms: b.ms + d * DAY_MS };
      }
      if ((n.op === '+' || n.op === '-') && isFTime(a)) {
        const h = this.num(b, n.r);
        return h === null ? null : { k: 'time', min: a.min + (n.op === '-' ? -h : h) * 60 };
      }
      throw new RuntimeError('Esa operación no se puede hacer con fechas u horas.');
    }
    const x = this.num(a, n.l);
    const y = this.num(b, n.r);
    if (x === null || y === null) return null;
    switch (n.op) {
      case '+':
        return x + y;
      case '-':
        return x - y;
      case '*':
        return x * y;
      case '/':
        if (y === 0) {
          this.warn('No se puede dividir entre cero.');
          return null;
        }
        return x / y;
      case '^': {
        const r = x ** y;
        if (!Number.isFinite(r)) {
          this.warn('Esa potencia no da un número.');
          return null;
        }
        return r;
      }
    }
    throw new RuntimeError('Operación desconocida.');
  }

  private compare(op: string, a: FVal, b: FVal): boolean {
    const eq = op === '=' || op === '<>';
    let cmp: number | null;
    if (a === null || b === null) {
      if (a === null && b === null) cmp = 0;
      else {
        // Igualdad: «vacío» vale '', 0 y falso. Orden: vacío no es ni menor ni mayor.
        const other = (a === null ? b : a) as Exclude<FVal, null>;
        const blankLike =
          other === '' ||
          other === 0 ||
          other === false ||
          (typeof other === 'string' && !other.trim());
        if (!eq) return false;
        return op === '=' ? blankLike : !blankLike;
      }
    } else if (isFDate(a) || isFDate(b)) {
      const da = isFDate(a) ? a : typeof a === 'string' ? parseDateText(a) : null;
      const db = isFDate(b) ? b : typeof b === 'string' ? parseDateText(b) : null;
      cmp = da && db ? Math.sign(da.ms - db.ms) : null;
    } else if (isFTime(a) || isFTime(b)) {
      const ta = isFTime(a) ? a : typeof a === 'string' ? parseTimeText(a) : null;
      const tb = isFTime(b) ? b : typeof b === 'string' ? parseTimeText(b) : null;
      cmp = ta && tb ? Math.sign(ta.min - tb.min) : null;
    } else if (typeof a === 'string' && typeof b === 'string') {
      const na = parseLooseNumber(a);
      const nb = parseLooseNumber(b);
      cmp =
        na !== null && nb !== null
          ? Math.sign(na - nb)
          : fold(a) === fold(b)
            ? 0
            : fold(a).localeCompare(fold(b), 'es');
    } else if (typeof a === 'boolean' || typeof b === 'boolean') {
      const na = typeof a === 'boolean' ? (a ? 1 : 0) : Number(a);
      const nb = typeof b === 'boolean' ? (b ? 1 : 0) : Number(b);
      cmp = Number.isNaN(na) || Number.isNaN(nb) ? null : Math.sign(na - nb);
    } else {
      const na = typeof a === 'number' ? a : parseLooseNumber(String(a));
      const nb = typeof b === 'number' ? b : parseLooseNumber(String(b));
      cmp = na !== null && nb !== null ? Math.sign(na - nb) : null;
    }
    if (cmp === null) {
      // Cosas de distinto tipo: sólo se puede decir que no son iguales.
      if (op === '=') return false;
      if (op === '<>') return true;
      throw new RuntimeError('No se pueden ordenar valores de distinto tipo.');
    }
    switch (op) {
      case '=':
        return cmp === 0;
      case '<>':
        return cmp !== 0;
      case '<':
        return cmp < 0;
      case '<=':
        return cmp <= 0;
      case '>':
        return cmp > 0;
      default:
        return cmp >= 0;
    }
  }

  private call(n: Extract<FNode, { t: 'call' }>): FVal {
    const args = n.args;
    const a = (i: number) => args[i] as FNode;
    const numAt = (i: number) => this.num(this.ev(a(i)), a(i));
    const nums = (): number[] => {
      const out: number[] = [];
      for (const [i] of args.entries()) {
        const x = numAt(i);
        if (x !== null) out.push(x);
      }
      return out;
    };
    const textAt = (i: number) => textOf(this.ev(a(i)));
    switch (n.fn) {
      case 'redondear':
      case 'redondear_mas':
      case 'redondear_menos': {
        const x = numAt(0);
        if (x === null) return null;
        const dec = args.length > 1 ? (numAt(1) ?? 0) : 0;
        const d = Math.max(0, Math.min(12, Math.trunc(dec)));
        if (n.fn === 'redondear') return roundTo(x, d);
        const f = 10 ** d;
        // Se redondea antes (15 cifras) para que 2,3 × 100 no dé 230,00000000000003 y suba.
        const scaled = Number((x * f).toPrecision(14));
        return (n.fn === 'redondear_mas' ? Math.ceil(scaled) : Math.floor(scaled)) / f;
      }
      case 'entero': {
        const x = numAt(0);
        return x === null ? null : Math.floor(x);
      }
      case 'abs': {
        const x = numAt(0);
        return x === null ? null : Math.abs(x);
      }
      case 'min':
      case 'max': {
        const list = nums();
        if (!list.length) return null;
        return n.fn === 'min' ? Math.min(...list) : Math.max(...list);
      }
      case 'suma': {
        const list = nums();
        return list.length ? list.reduce((s, x) => s + x, 0) : 0;
      }
      case 'promedio': {
        const list = nums();
        return list.length ? list.reduce((s, x) => s + x, 0) / list.length : null;
      }
      case 'raiz': {
        const x = numAt(0);
        if (x === null) return null;
        if (x < 0) {
          this.warn('No hay raíz cuadrada de un número negativo.');
          return null;
        }
        return Math.sqrt(x);
      }
      case 'potencia': {
        const x = numAt(0);
        const y = numAt(1);
        if (x === null || y === null) return null;
        const r = x ** y;
        if (!Number.isFinite(r)) {
          this.warn('Esa potencia no da un número.');
          return null;
        }
        return r;
      }
      case 'residuo': {
        const x = numAt(0);
        const y = numAt(1);
        if (x === null || y === null) return null;
        if (y === 0) {
          this.warn('No se puede dividir entre cero.');
          return null;
        }
        return x - y * Math.floor(x / y);
      }
      case 'si': {
        // Perezoso: sólo se calcula la rama elegida (un ÷ 0 en la otra no avisa).
        const cond = this.truthy(this.ev(a(0)), a(0));
        return this.ev(cond ? a(1) : a(2));
      }
      case 'si_error': {
        const before = this.warnings.length;
        try {
          const v = this.ev(a(0));
          if (v !== null || this.warnings.length === before) return v;
        } catch (err) {
          if (!(err instanceof RuntimeError)) throw err;
        }
        this.warnings.length = before;
        return this.ev(a(1));
      }
      case 'y':
      case 'o': {
        const flags = args.map((_, i) => this.truthy(this.ev(a(i)), a(i)));
        return n.fn === 'y' ? flags.every(Boolean) : flags.some(Boolean);
      }
      case 'no':
        return !this.truthy(this.ev(a(0)), a(0));
      case 'vacio': {
        const v = this.ev(a(0));
        return v === null || (typeof v === 'string' && v.trim() === '');
      }
      case 'concatenar':
        return args.map((_, i) => textAt(i)).join('');
      case 'unir': {
        const sep = textAt(0);
        return args
          .slice(1)
          .map((_, i) => textAt(i + 1))
          .filter((t) => t !== '')
          .join(sep);
      }
      case 'texto': {
        const v = this.ev(a(0));
        if (args.length > 1 && typeof v === 'number') {
          const d = Math.max(0, Math.min(12, Math.trunc(numAt(1) ?? 0)));
          return roundTo(v, d).toFixed(d).replace('.', ',');
        }
        return textOf(v);
      }
      case 'numero': {
        const v = this.ev(a(0));
        if (v === null) return null;
        const x = this.num(v, a(0));
        return x;
      }
      case 'mayusculas':
        return textAt(0).toUpperCase();
      case 'minusculas':
        return textAt(0).toLowerCase();
      case 'largo':
        return textAt(0).length;
      case 'izquierda': {
        const k = Math.max(0, Math.trunc(numAt(1) ?? 0));
        return textAt(0).slice(0, k);
      }
      case 'derecha': {
        const k = Math.max(0, Math.trunc(numAt(1) ?? 0));
        return k === 0 ? '' : textAt(0).slice(-k);
      }
      case 'recortar':
        return textAt(0).trim();
      case 'reemplazar': {
        const find = textAt(1);
        return find ? textAt(0).split(find).join(textAt(2)) : textAt(0);
      }
      case 'contiene': {
        const find = fold(textAt(1));
        return find === '' ? true : fold(textAt(0)).includes(find);
      }
      case 'trm': {
        const day = args.length ? this.date(this.ev(a(0)), a(0)) : parseDateText(this.ctx.today);
        if (!day) return null;
        const iso = new Date(day.ms).toISOString().slice(0, 10);
        const table = this.ctx.trm ?? ambientTrm();
        const got = trmOn(table, iso);
        if (!got.ok) {
          this.warn(trmWarning(got, iso) ?? 'Sin TRM oficial para esa fecha.');
          return null;
        }
        return got.value;
      }
      case 'hoy': {
        const d = parseDateText(this.ctx.today);
        return d ?? null;
      }
      case 'ahora': {
        const d = parseDateText(`${this.ctx.today} ${this.ctx.now}`);
        return d ?? null;
      }
      case 'fecha': {
        const y = numAt(0);
        const m = numAt(1);
        const d = numAt(2);
        if (y === null || m === null || d === null) return null;
        const ms = Date.UTC(y, m - 1, d);
        const chk = new Date(ms);
        if (chk.getUTCFullYear() !== y || chk.getUTCMonth() !== m - 1 || chk.getUTCDate() !== d) {
          this.warn('Esa fecha no existe en el calendario.');
          return null;
        }
        return { k: 'date', ms, time: false };
      }
      case 'fecha_hora': {
        const d = this.date(this.ev(a(0)), a(0));
        const tv = this.ev(a(1));
        if (d === null || tv === null) return d === null ? null : d;
        const t = isFTime(tv) ? tv : typeof tv === 'string' ? parseTimeText(tv) : null;
        if (!t) throw new RuntimeError(`${label(a(1))} no es una hora.`);
        const day = Math.floor(d.ms / DAY_MS) * DAY_MS;
        return { k: 'date', ms: day + t.min * 60_000, time: true };
      }
      case 'dias_entre': {
        const d1 = this.date(this.ev(a(0)), a(0));
        const d2 = this.date(this.ev(a(1)), a(1));
        if (!d1 || !d2) return null;
        return Math.round(
          (Math.floor(d2.ms / DAY_MS) * DAY_MS - Math.floor(d1.ms / DAY_MS) * DAY_MS) / DAY_MS,
        );
      }
      case 'horas_entre':
      case 'minutos_entre': {
        const m1 = this.minutesOf(this.ev(a(0)), a(0));
        const m2 = this.minutesOf(this.ev(a(1)), a(1));
        if (!m1 || !m2) return null;
        if (m1.abs !== m2.abs)
          throw new RuntimeError(
            'Para contar horas, los dos valores son fechas con hora o los dos son horas.',
          );
        const mins = m2.v - m1.v;
        return n.fn === 'horas_entre' ? mins / 60 : mins;
      }
      case 'ano':
      case 'mes':
      case 'dia':
      case 'dia_semana': {
        const d = this.date(this.ev(a(0)), a(0));
        if (!d) return null;
        const x = new Date(d.ms);
        if (n.fn === 'ano') return x.getUTCFullYear();
        if (n.fn === 'mes') return x.getUTCMonth() + 1;
        if (n.fn === 'dia') return x.getUTCDate();
        return ((x.getUTCDay() + 6) % 7) + 1;
      }
      case 'hora':
      case 'minuto': {
        const v = this.ev(a(0));
        if (v === null) return null;
        let mins: number;
        if (isFTime(v)) mins = v.min;
        else {
          const d = this.date(v, a(0));
          if (!d) return null;
          mins = (d.ms % DAY_MS) / 60_000;
        }
        return n.fn === 'hora' ? Math.floor(mins / 60) : Math.floor(mins % 60);
      }
      case 'sumar_dias': {
        const d = this.date(this.ev(a(0)), a(0));
        const k = numAt(1);
        if (!d || k === null) return null;
        return { ...d, ms: d.ms + k * DAY_MS };
      }
      case 'sumar_meses': {
        const d = this.date(this.ev(a(0)), a(0));
        const k = numAt(1);
        if (!d || k === null) return null;
        const x = new Date(d.ms);
        const target = x.getUTCMonth() + Math.trunc(k);
        const last = new Date(Date.UTC(x.getUTCFullYear(), target + 1, 0)).getUTCDate();
        const day = Math.min(x.getUTCDate(), last);
        return {
          ...d,
          ms: Date.UTC(x.getUTCFullYear(), target, day, x.getUTCHours(), x.getUTCMinutes()),
        };
      }
      case 'fin_de_mes': {
        const d = this.date(this.ev(a(0)), a(0));
        if (!d) return null;
        const x = new Date(d.ms);
        return { k: 'date', ms: Date.UTC(x.getUTCFullYear(), x.getUTCMonth() + 1, 0), time: false };
      }
    }
    throw new RuntimeError(`No conozco la función «${n.fn}».`);
  }
}

function label(n: FNode): string {
  if (n.t === 'ref') return `«${n.name}»`;
  if (n.t === 'call') return `El resultado de ${n.fn}()`;
  return 'Ese valor';
}

/** Calcula una fórmula ya leída. No lanza: un fallo deja el resultado vacío y dice por qué. */
export function evaluateParsed(parsed: ParsedFormula, ctx: FormulaContext): FormulaResult {
  const run = new Run(ctx);
  try {
    const value = run.ev(parsed.ast);
    // Un número que no es finito (desbordó) no es un valor.
    if (typeof value === 'number' && !Number.isFinite(value)) {
      run.warn('El resultado es demasiado grande.');
      return { value: null, warnings: run.warnings };
    }
    return { value, warnings: run.warnings };
  } catch (err) {
    if (err instanceof RuntimeError)
      return { value: null, warnings: run.warnings, error: err.message };
    return { value: null, warnings: run.warnings, error: 'No pude calcular la fórmula.' };
  }
}

/** Lee y calcula en un paso (para pruebas y vistas previas). */
export function evaluateFormula(source: string, ctx: FormulaContext): FormulaResult {
  const parsed = parseFormula(source);
  if (!parsed.ok) return { value: null, warnings: [], error: parsed.message };
  return evaluateParsed(parsed.formula, ctx);
}
