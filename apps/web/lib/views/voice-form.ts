import type { TrackerField } from '@cortex/agent-tools';
import { parseCheckbox } from '@cortex/agent-tools/src/trackers/schema';
import {
  validateRowValues,
  violationsByKey,
  visibleKeys,
} from '@cortex/agent-tools/src/trackers/validation';
import { stepFields, visibleSteps } from '@cortex/agent-tools/src/views/form-extras';
import { foldSpoken, parseSpokenNumber, spokenDigits, spokenNumbers } from './spoken-number';

/**
 * EL MOTOR DE LA CONVERSACIÓN PARA LLENAR UN FORMULARIO HABLANDO.
 *
 * Puro y sin navegador: recibe lo que la persona dijo (texto) y devuelve el
 * estado nuevo, lo que Cortex dice en voz alta y, si toca, un efecto (enviar,
 * pedir la ubicación, cancelar). La voz, el micrófono y el envío viven en
 * components/views/useVoiceForm.ts; aquí sólo está la conversación, para poder
 * probarla sin nada de eso.
 *
 * QUÉ ENTIENDE SIN MODELO (determinista, gratis, sin red):
 *   - comandos cortos: repite, salta, atrás, corrige <campo>, cancela, lee lo
 *     que llevo, enviar, y sí / no al confirmar;
 *   - la respuesta a UN campo cuando es simple: sí/no, una cifra, una fecha
 *     relativa («hoy», «ayer», «el lunes», «5 de marzo»), una hora, una opción
 *     por parecido, un texto o código sin más datos.
 * Todo lo demás —una frase con varios datos («guía 045…, vuelo AV204, 4
 * piezas»), algo que no se pudo leer— devuelve `server: true` y quien llama
 * pregunta al servidor (`voice-turn.ts`) y aplica su respuesta con
 * `applyServerTurn`. Nunca se guarda nada aquí: el envío sale por el mismo
 * camino del formulario.
 */

export type VoicePhase = 'asking' | 'confirming' | 'done';

export interface VoiceDef {
  /** Los campos del formulario, en su orden (los que pide el bloque). */
  fields: TrackerField[];
  steps?: Array<{ title: string; fields: string[] }> | null;
  /** Lo que se valida de un valor guardado (una foto pendiente cuenta como puesta). */
  prepare?: (value: string) => string;
}

export interface VoiceCtx {
  /** AAAA-MM-DD de hoy (hora de Bogotá). */
  today: string;
  /** HH:MM de ahora. */
  now: string;
}

export interface VoiceState {
  phase: VoicePhase;
  /** El campo que se está preguntando (null al confirmar). */
  current: string | null;
  values: Record<string, string>;
  /** Campos que se saltaron a propósito (o que se llenan en la pantalla). */
  skipped: string[];
  /** Tras corregir un campo desde el resumen, se vuelve al resumen. */
  returnToConfirm: boolean;
  /** En el resumen dijeron «no»: se espera cuál campo corregir. */
  awaitingFix: boolean;
  /** Respuestas seguidas que no se entendieron (a las dos se ofrece la pantalla). */
  misses: number;
}

export type VoiceEffect =
  | { type: 'geolocate'; key: string }
  | { type: 'submit' }
  | { type: 'cancel' };

export interface VoiceOutcome {
  state: VoiceState;
  /** Lo que Cortex dice en voz alta (puede estar vacío). */
  say: string;
  effect?: VoiceEffect;
  /** La respuesta no es simple: que la lea el servidor. */
  server?: boolean;
}

export const VOICE_COMMANDS = [
  'repeat',
  'skip',
  'back',
  'cancel',
  'read',
  'send',
  'correct',
] as const;
export type VoiceCommand = (typeof VOICE_COMMANDS)[number];

export interface ServerTurn {
  values: Record<string, string>;
  command?: VoiceCommand | null;
  /** Para `correct`: la clave del campo a corregir, si se dijo. */
  commandField?: string | null;
}

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

const SCREEN_ONLY: ReadonlySet<string> = new Set(['file', 'relation']);
const blank = (v: unknown) => v === undefined || v === null || String(v).trim() === '';
const fold = foldSpoken;
const words = (t: string) => (t ? t.split(' ') : []);

function lev(a: string, b: string): number {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let diag = prev[0] as number;
    prev[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const up = prev[j] as number;
      prev[j] = Math.min(
        up + 1,
        (prev[j - 1] as number) + 1,
        diag + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      diag = up;
    }
  }
  return prev[b.length] as number;
}

/** 0–1: qué tan parecidas son dos frases ya sin tildes. */
export function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const longest = Math.max(a.length, b.length);
  return 1 - lev(a, b) / longest;
}

function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const weekdayOf = (day: string) => new Date(`${day}T00:00:00Z`).getUTCDay();
const pad = (n: number) => String(n).padStart(2, '0');

export function orderedKeys(def: VoiceDef): string[] {
  const keys = def.fields.map((f) => f.key);
  if (!def.steps?.length) return keys;
  return stepFields(def.steps as never, keys).flatMap((s) => s.fields);
}

const fieldOf = (def: VoiceDef, key: string | null) =>
  key ? def.fields.find((f) => f.key === key) : undefined;
const isScreenOnly = (f: TrackerField) => SCREEN_ONLY.has(f.type);
const label = (f: TrackerField) => f.label.trim();

function visibleSet(def: VoiceDef, values: Record<string, string>): Set<string> {
  return visibleKeys(def.fields, values);
}

/** Lo que el formulario valida: «viewer» lo pone el servidor, no se exige. */
function violations(def: VoiceDef, values: Record<string, string>): Record<string, string> {
  const prep = def.prepare ?? ((v: string) => v);
  return violationsByKey(
    validateRowValues(
      def.fields.map((f) => (f.default === 'viewer' ? { ...f, required: false } : f)),
      Object.fromEntries(Object.entries(values).map(([k, v]) => [k, prep(v)])),
    ),
  );
}

// ---------------------------------------------------------------------------
// Cómo se dice un valor (resumen y «lo que llevo»)
// ---------------------------------------------------------------------------

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
const WEEKDAYS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

export function spokenDate(iso: string, today?: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  if (today) {
    if (iso === today) return 'hoy';
    if (iso === addDays(today, -1)) return 'ayer';
    if (iso === addDays(today, 1)) return 'mañana';
  }
  const wd = WEEKDAYS[weekdayOf(iso)];
  const sameYear = !today || today.slice(0, 4) === m[1];
  return `${wd} ${Number(m[3])} de ${MONTHS[Number(m[2]) - 1]}${sameYear ? '' : ` de ${m[1]}`}`;
}

export function spokenTime(hhmm: string): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) return hhmm;
  const h = Number(m[1]);
  const min = Number(m[2]);
  const h12 = h % 12 === 0 ? 12 : h % 12;
  const part = h < 12 ? 'de la mañana' : h < 19 ? 'de la tarde' : 'de la noche';
  const mins = min === 0 ? '' : min === 30 ? ' y media' : min === 15 ? ' y cuarto' : ` y ${min}`;
  return `${h12}${mins} ${part}`;
}

/** El valor tal como se lee en voz alta. Vacío si no hay nada que decir. */
export function spokenValue(f: TrackerField, value: string, today?: string): string {
  if (blank(value)) return '';
  switch (f.type) {
    case 'checkbox':
      return parseCheckbox(value) === 1 ? 'sí' : 'no';
    case 'date':
      return spokenDate(value, today);
    case 'time':
      return spokenTime(value);
    case 'money': {
      const n = Number(value);
      return Number.isFinite(n) ? `${n.toLocaleString('es-CO')} pesos` : value;
    }
    case 'number': {
      const n = Number(value);
      return Number.isFinite(n) ? n.toLocaleString('es-CO') : value;
    }
    case 'file':
      return 'archivo adjunto';
    case 'location':
      return 'ubicación puesta';
    case 'relation':
      return (/"label"\s*:\s*"([^"]+)"/.exec(value)?.[1] ?? 'elegido') as string;
    default:
      return value.trim();
  }
}

/** Los campos con algo, ya leíbles: «Guía: 729…, Piezas: 4». */
export function summaryLine(def: VoiceDef, values: Record<string, string>, today?: string): string {
  const visible = visibleSet(def, values);
  return orderedKeys(def)
    .map((k) => fieldOf(def, k))
    .filter((f): f is TrackerField => Boolean(f) && visible.has((f as TrackerField).key))
    .map((f) => {
      const v = spokenValue(f, values[f.key] ?? '', today);
      return v ? `${label(f)}: ${v}` : '';
    })
    .filter(Boolean)
    .join('. ');
}

// ---------------------------------------------------------------------------
// Preguntas
// ---------------------------------------------------------------------------

/** Lo que se dice para pedir un campo, según su tipo. */
export function promptFor(f: TrackerField): string {
  const l = label(f);
  const optional = f.required ? '' : ' Si no aplica, di «salta».';
  switch (f.type) {
    case 'select': {
      const opts = f.options ?? [];
      if (opts.length > 0 && opts.length <= 6) {
        const list =
          opts.length === 1
            ? (opts[0] as string)
            : `${opts.slice(0, -1).join(', ')} o ${opts[opts.length - 1]}`;
        return `${l}: ¿${list}?${optional}`;
      }
      return `${l}: dime la opción.${optional}`;
    }
    case 'date':
      return `${l}: ¿qué fecha? Puedes decir hoy, ayer o el lunes.${optional}`;
    case 'time':
      return `${l}: ¿a qué hora?${optional}`;
    case 'checkbox':
      return `${l}: ¿sí o no?`;
    case 'number':
      return `${l}: dime la cifra.${optional}`;
    case 'money':
      return `${l}: ¿cuánto es?${optional}`;
    case 'location':
      return `¿Uso tu ubicación actual para ${l}? Di sí, o salta.`;
    case 'longtext':
      return `${l}: cuéntame.${optional}`;
    default:
      return `${l}: dímelo.${optional}`;
  }
}

const SCREEN_SAY = (f: TrackerField) => `«${label(f)}» hay que llenarlo en la pantalla.`;

// ---------------------------------------------------------------------------
// Comandos
// ---------------------------------------------------------------------------

const POLITE = /\b(por favor|porfa|gracias|senor|senora|cortex|pues|eh|ah|mira|oye|ya)\b/g;
const normalizeCmd = (t: string) =>
  fold(t)
    .replace(POLITE, ' ')
    .replace(/[.,;:!?]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const CMD_LISTS: Array<[VoiceCommand, RegExp]> = [
  [
    'repeat',
    /^(repite|repitelo|repetir|repite la pregunta|otra vez|de nuevo|como|que|que dijiste|no te oi|no entendi|no te entendi|puedes repetir|repite eso|dilo otra vez)$/,
  ],
  [
    'skip',
    /^(salta|saltalo|saltar|salta ese|siguiente|sigue|pasa|pasar|pasalo|omite|omitir|ese no|no se|no sabe|sin dato|no aplica|ninguno|ninguna|nada)$/,
  ],
  [
    'back',
    /^(atras|regresa|regresar|anterior|vuelve|volver|devuelvete|retrocede|atras por favor)$/,
  ],
  [
    'cancel',
    /^(cancela|cancelar|cancelalo|cancela todo|olvidalo|salir|sal|detente|parar|para|basta)$/,
  ],
  [
    'read',
    /^(lee lo que llevo|leer lo que llevo|lee|leer|que llevo|lo que llevo|resumen|dime lo que llevo|lee el resumen|lee lo anotado|que has anotado|que tienes)$/,
  ],
  ['send', /^(enviar|envia|envialo|enviarlo|manda|mandalo|mandar|ya esta|termine|terminado)$/],
];

const CORRECT_RE =
  /^(?:corrige|corregir|corrijo|cambia|cambiar|modifica|modificar|me equivoque en|esta mal)\s*(?:el|la|los|las|lo de|lo del|de)?\s*(.*)$/;

/** Un comando dicho solo (frases cortas, anclado: «salta», no «la nota salta»). */
export function parseCommand(text: string): { command: VoiceCommand; target?: string } | null {
  const t = normalizeCmd(text);
  if (!t) return null;
  const fix = CORRECT_RE.exec(t);
  if (fix) return { command: 'correct', target: (fix[1] ?? '').trim() || undefined };
  for (const [command, re] of CMD_LISTS) if (re.test(t)) return { command };
  return null;
}

const YES_RE =
  /^(si|sii+|sip|sep|claro|dale|correcto|confirmo|confirmado|ok|okay|listo|afirmativo|exacto|perfecto|cierto|adelante|de una|asi es|esta bien|envialo|enviar|envia|manda|mandalo|vale|bueno|claro que si|si senor|si por favor)$/;
const NO_RE = /^(no|nop|nope|negativo|falso|nunca|para nada|no gracias|todavia no|aun no)$/;

export function isYes(text: string): boolean {
  return YES_RE.test(normalizeCmd(text));
}
export function isNo(text: string): boolean {
  return NO_RE.test(normalizeCmd(text));
}

/** El campo (askable y visible) al que se parece mejor `text`; null si ninguno o hay empate. */
export function findField(
  def: VoiceDef,
  text: string,
  keys: string[] = orderedKeys(def),
): TrackerField | null {
  const t = fold(text);
  if (!t) return null;
  const spoken = words(t);
  let best: { f: TrackerField; score: number } | null = null;
  let tie = false;
  for (const k of keys) {
    const f = fieldOf(def, k);
    if (!f) continue;
    const tokens = words(fold(f.label)).filter((w) => w.length > 2);
    if (!tokens.length) continue;
    const hit = tokens.filter((w) =>
      spoken.some((s) => s === w || (w.length >= 5 && s.length >= 5 && lev(s, w) <= 1)),
    ).length;
    const score = hit / tokens.length + (fold(f.label) === t ? 1 : 0);
    if (hit === 0 || score < 0.5) continue;
    if (!best || score > best.score) {
      best = { f, score };
      tie = false;
    } else if (score === best.score) tie = true;
  }
  return best && !tie ? best.f : null;
}

// ---------------------------------------------------------------------------
// Fechas y horas habladas
// ---------------------------------------------------------------------------

const DAY_NAMES: Array<[RegExp, number]> = [
  [/\bdomingo\b/, 0],
  [/\blunes\b/, 1],
  [/\bmartes\b/, 2],
  [/\bmiercoles\b/, 3],
  [/\bjueves\b/, 4],
  [/\bviernes\b/, 5],
  [/\bsabado\b/, 6],
];
const MONTH_RE = new RegExp(
  `\\b(${['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre|setiembre', 'octubre', 'noviembre', 'diciembre'].join('|')})\\b`,
);

function validDay(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const iso = `${y}-${pad(m)}-${pad(d)}`;
  const back = new Date(`${iso}T00:00:00Z`);
  return back.getUTCMonth() + 1 === m && back.getUTCDate() === d ? iso : null;
}

/** «hoy», «ayer», «el lunes», «5 de marzo», «15/03/2026» → AAAA-MM-DD; null si no es una fecha. */
export function parseSpokenDate(
  text: string,
  ctx: { today: string },
  field?: Pick<TrackerField, 'min' | 'max'>,
): string | null {
  const t = fold(text).replace(/\bdel\b/g, 'de');
  const [yy, mm] = ctx.today.split('-').map(Number) as [number, number, number];
  const iso = /(\d{4})-(\d{2})-(\d{2})/.exec(t);
  if (iso) return validDay(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const dmy = /\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\b/.exec(t);
  if (dmy) {
    const y = dmy[3] ? (dmy[3].length === 2 ? 2000 + Number(dmy[3]) : Number(dmy[3])) : yy;
    return validDay(y, Number(dmy[2]), Number(dmy[1]));
  }
  if (/\banteayer\b|\bantier\b|\bantes de ayer\b/.test(t)) return addDays(ctx.today, -2);
  if (/\bayer\b/.test(t)) return addDays(ctx.today, -1);
  if (/\bpasado manana\b/.test(t)) return addDays(ctx.today, 2);
  if (/\bhoy\b/.test(t)) return ctx.today;
  if (/\bmanana\b/.test(t)) return addDays(ctx.today, 1);
  const ago = /\bhace\s+(.+?)\s+dias?\b/.exec(t);
  if (ago) {
    const n = spokenNumbers(ago[1] as string)[0];
    if (n !== undefined) return addDays(ctx.today, -n);
  }
  const ahead = /\ben\s+(.+?)\s+dias?\b/.exec(t);
  if (ahead) {
    const n = spokenNumbers(ahead[1] as string)[0];
    if (n !== undefined) return addDays(ctx.today, n);
  }
  const day = DAY_NAMES.find(([re]) => re.test(t));
  if (day) {
    const target = day[1];
    const todayWd = weekdayOf(ctx.today);
    const forward = (target - todayWd + 7) % 7; // 0 = hoy
    const backward = (todayWd - target + 7) % 7;
    if (/\b(proximo|siguiente|que viene)\b/.test(t))
      return addDays(ctx.today, forward === 0 ? 7 : forward);
    if (/\b(pasado|anterior)\b/.test(t))
      return addDays(ctx.today, -(backward === 0 ? 7 : backward));
    // Sin más: los registros miran atrás; una fecha que no puede ser pasada mira adelante.
    return field?.min === 'today' ? addDays(ctx.today, forward) : addDays(ctx.today, -backward);
  }
  const month = MONTH_RE.exec(t);
  if (month) {
    const before = t.slice(0, month.index);
    const after = t.slice(month.index + month[0].length);
    const d = spokenNumbers(before).pop() ?? (/\bprimero\b/.test(before) ? 1 : undefined);
    if (d === undefined) return null;
    const y = spokenNumbers(after).find((n) => n >= 1900 && n <= 2100) ?? yy;
    const m = [
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
    ].indexOf(month[1] === 'setiembre' ? 'septiembre' : (month[1] as string));
    return validDay(y, m + 1, d);
  }
  // «el 15»: el día 15 de este mes.
  const bare = /^(?:el\s+)?(?:dia\s+)?(.+)$/.exec(t);
  if (bare && words(t).length <= 3) {
    const nums = spokenNumbers(bare[1] as string);
    if (nums.length === 1 && Number.isInteger(nums[0]) && (nums[0] as number) <= 31)
      return validDay(yy, mm, nums[0] as number);
  }
  return null;
}

/** «a las tres de la tarde», «15:30», «ocho y media», «mediodía» → HH:MM; null si no es una hora. */
export function parseSpokenTime(text: string, ctx: { now: string }): string | null {
  const t = fold(text);
  if (/\bmediodia\b/.test(t)) return '12:00';
  if (/\bmedianoche\b/.test(t)) return '00:00';
  if (/\b(ahora|ahorita|ya mismo)\b/.test(t)) return ctx.now;
  const colon = /\b(\d{1,2})[:.h](\d{2})\b/.exec(t);
  let h: number;
  let min = 0;
  if (colon) {
    h = Number(colon[1]);
    min = Number(colon[2]);
  } else {
    const rest = t.replace(/\b(a|las|la|son|es)\b/g, ' ').replace(/\s+/g, ' ');
    const nums = spokenNumbers(rest);
    if (!nums.length) return null;
    h = nums[0] as number;
    if (/\by media\b/.test(rest)) min = 30;
    else if (/\by cuarto\b/.test(rest)) min = 15;
    else if (/\bmenos cuarto\b/.test(rest)) {
      min = 45;
      h -= 1;
    } else if (nums.length >= 2 && /\by\b/.test(rest)) min = nums[1] as number;
    else if (nums.length >= 2 && (nums[1] as number) < 60) min = nums[1] as number;
  }
  if (!Number.isInteger(h) || !Number.isInteger(min) || h < 0 || h > 24 || min < 0 || min > 59)
    return null;
  if (/\b(tarde|noche)\b/.test(t) && h < 12) h += 12;
  if (/\bmanana\b/.test(t) && h === 12) h = 0;
  if (h === 24) h = 0;
  return `${pad(h)}:${pad(min)}`;
}

// ---------------------------------------------------------------------------
// La respuesta a un campo
// ---------------------------------------------------------------------------

type Answer =
  | { kind: 'value'; value: string }
  | { kind: 'invalid'; say: string }
  | { kind: 'unknown' };

const ORDINALS: Record<string, number> = {
  primero: 1,
  primera: 1,
  segundo: 2,
  segunda: 2,
  tercero: 3,
  tercera: 3,
  cuarto: 4,
  cuarta: 4,
  quinto: 5,
  quinta: 5,
  sexto: 6,
  sexta: 6,
};

function pickOption(f: TrackerField, text: string): Answer {
  const opts = f.options ?? [];
  const t = fold(text)
    .replace(/\b(la|el|opcion|es|son|seria|pues|de)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return { kind: 'unknown' };
  const folded = opts.map((o) => ({ o, f: fold(o) }));
  const exact = folded.find((x) => x.f === t);
  if (exact) return { kind: 'value', value: exact.o };
  // «la dos», «la primera»: sólo con pocas opciones y una frase corta.
  if (opts.length <= 6 && words(t).length <= 2) {
    const ord = ORDINALS[t] ?? (spokenNumbers(t).length === 1 ? spokenNumbers(t)[0] : undefined);
    if (ord && Number.isInteger(ord) && ord >= 1 && ord <= opts.length)
      return { kind: 'value', value: opts[ord - 1] as string };
  }
  const contained = folded.filter((x) => x.f && (` ${t} `.includes(` ${x.f} `) || t.includes(x.f)));
  if (contained.length === 1) return { kind: 'value', value: (contained[0] as { o: string }).o };
  if (contained.length > 1) {
    const longest = [...contained].sort((a, b) => b.f.length - a.f.length);
    if ((longest[0] as { f: string }).f.length > (longest[1] as { f: string }).f.length + 2)
      return { kind: 'value', value: (longest[0] as { o: string }).o };
    return { kind: 'invalid', say: `¿Cuál: ${contained.map((x) => x.o).join(' o ')}?` };
  }
  const partial = folded.filter((x) => t.length >= 3 && x.f.includes(t));
  if (partial.length === 1) return { kind: 'value', value: (partial[0] as { o: string }).o };
  if (partial.length > 1)
    return { kind: 'invalid', say: `¿Cuál: ${partial.map((x) => x.o).join(' o ')}?` };
  // Una palabra propia de UNA opción («novedad» → «Con novedad»).
  const spoken = words(t);
  const byToken = folded.filter((x) =>
    words(x.f).some(
      (w) =>
        w.length >= 4 &&
        spoken.includes(w) &&
        folded.every((y) => y === x || !words(y.f).includes(w)),
    ),
  );
  if (byToken.length === 1) return { kind: 'value', value: (byToken[0] as { o: string }).o };
  const scored = folded.map((x) => ({ o: x.o, s: similarity(t, x.f) })).sort((a, b) => b.s - a.s);
  const top = scored[0];
  if (top && top.s >= 0.75 && top.s - (scored[1]?.s ?? 0) >= 0.1)
    return { kind: 'value', value: top.o };
  return { kind: 'unknown' };
}

const FORMAT_DIGITISH = new Set(['digits', 'awb', 'nit', 'phone', 'plate']);

function onlyCodeWords(t: string): boolean {
  return words(t).every(
    (w) =>
      /^[\d.\-/]+$/.test(w) ||
      /^(cero|uno|un|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce|trece|catorce|quince|veinte\w*|treinta|cuarenta|cincuenta|sesenta|setenta|ochenta|noventa|y|guion|raya)$/.test(
        w,
      ),
  );
}

/** ¿La frase trae varios datos (nombra otros campos o es una lista con comas)? Entonces la lee el servidor. */
export function looksMultiData(def: VoiceDef, current: TrackerField | null, text: string): boolean {
  const t = fold(text);
  if (words(t).length < 5) return false;
  if ((text.match(/,/g) ?? []).length >= 2) return true;
  const spoken = new Set(words(t));
  let named = 0;
  for (const f of def.fields) {
    if (f.key === current?.key) continue;
    const tokens = words(fold(f.label)).filter((w) => w.length > 3);
    if (tokens.length && tokens.every((w) => spoken.has(w))) named += 1;
  }
  return named >= 1;
}

function interpret(def: VoiceDef, f: TrackerField, text: string, ctx: VoiceCtx): Answer {
  const heard = text.trim();
  const t = fold(heard);
  switch (f.type) {
    case 'checkbox': {
      if (isYes(heard) || /^(si|claro)\b/.test(t)) return { kind: 'value', value: '1' };
      if (isNo(heard) || /^no\b/.test(t)) return { kind: 'value', value: '0' };
      return { kind: 'unknown' };
    }
    case 'select':
      return pickOption(f, heard);
    case 'number':
    case 'money': {
      const nums = spokenNumbers(heard);
      if (nums.length !== 1 || words(t).length > 6) return { kind: 'unknown' };
      const n = nums[0] as number;
      return { kind: 'value', value: String(n) };
    }
    case 'date': {
      const d = parseSpokenDate(heard, ctx, f);
      return d ? { kind: 'value', value: d } : { kind: 'unknown' };
    }
    case 'time': {
      const h = parseSpokenTime(heard, ctx);
      return h ? { kind: 'value', value: h } : { kind: 'unknown' };
    }
    case 'location':
    case 'file':
    case 'relation':
      return { kind: 'unknown' };
    default: {
      if (!t) return { kind: 'unknown' };
      if (looksMultiData(def, f, heard)) return { kind: 'unknown' };
      const codeLike = FORMAT_DIGITISH.has(String(f.format)) || f.scan;
      let value = heard.replace(/[.\s]+$/g, '');
      if (
        codeLike ||
        (f.type === 'text' &&
          onlyCodeWords(t) &&
          /\d|cero|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve/.test(t))
      )
        value = spokenDigits(heard).toUpperCase();
      if (f.format === 'plate') value = value.replace(/\s+/g, '').toUpperCase();
      return { kind: 'value', value };
    }
  }
}

// ---------------------------------------------------------------------------
// Avanzar
// ---------------------------------------------------------------------------

const needsAnswer = (
  def: VoiceDef,
  s: Pick<VoiceState, 'values' | 'skipped'>,
  visible: Set<string>,
  key: string,
) => {
  const f = fieldOf(def, key);
  return Boolean(f) && visible.has(key) && !s.skipped.includes(key) && blank(s.values[key]);
};

/** El siguiente campo por preguntar después de `after` (o desde el principio). */
export function nextPending(
  def: VoiceDef,
  state: VoiceState,
  after?: string | null,
): string | null {
  const order = orderedKeys(def);
  const visible = visibleSet(def, state.values);
  const from = after ? order.indexOf(after) + 1 : 0;
  for (const k of order.slice(Math.max(from, 0))) if (needsAnswer(def, state, visible, k)) return k;
  // Una pasada completa: un campo que un showIf hizo visible más arriba.
  for (const k of order) if (needsAnswer(def, state, visible, k)) return k;
  return null;
}

/** Los obligatorios y visibles que siguen vacíos. */
function missingRequired(def: VoiceDef, values: Record<string, string>): TrackerField[] {
  const visible = visibleSet(def, values);
  return orderedKeys(def)
    .map((k) => fieldOf(def, k))
    .filter(
      (f): f is TrackerField =>
        Boolean(f) &&
        visible.has((f as TrackerField).key) &&
        (f as TrackerField).required &&
        (f as TrackerField).default !== 'viewer' &&
        blank(values[(f as TrackerField).key]),
    );
}

const join = (...parts: Array<string | undefined>) => parts.filter(Boolean).join(' ');

/**
 * Pasa a preguntar `key`; si es un campo de pantalla lo dice y sigue con el
 * siguiente. Al acabar los campos, el resumen.
 */
function ask(
  def: VoiceDef,
  state: VoiceState,
  key: string | null,
  ctx: VoiceCtx,
  lead = '',
): VoiceOutcome {
  let s = state;
  let say = lead;
  let k = key;
  // Campos de pantalla: se anuncian y se saltan.
  for (let guard = 0; k && guard < def.fields.length + 2; guard += 1) {
    const f = fieldOf(def, k);
    if (!f) break;
    if (isScreenOnly(f)) {
      say = join(say, SCREEN_SAY(f));
      s = { ...s, skipped: s.skipped.includes(k) ? s.skipped : [...s.skipped, k] };
      k = nextPending(def, s, k);
      continue;
    }
    return {
      state: { ...s, phase: 'asking', current: k, awaitingFix: false },
      say: join(say, promptFor(f)),
    };
  }
  return confirm({ ...s, current: null }, def, ctx, say);
}

function confirm(state: VoiceState, def: VoiceDef, ctx: VoiceCtx, lead = ''): VoiceOutcome {
  const missing = missingRequired(def, state.values);
  const body = summaryLine(def, state.values, ctx.today);
  const next: VoiceState = {
    ...state,
    phase: 'confirming',
    current: null,
    returnToConfirm: false,
    awaitingFix: false,
    misses: 0,
  };
  if (missing.length)
    return {
      state: next,
      say: join(
        lead,
        body ? `Llevo: ${body}.` : '',
        `Falta ${missing.map(label).join(', ')}: llénalo en la pantalla y di enviar.`,
      ),
    };
  return {
    state: next,
    say: join(lead, body ? `Voy a enviar: ${body}.` : 'No hay datos para enviar.', '¿Lo envío?'),
  };
}

const fresh = (values: Record<string, string>): VoiceState => ({
  phase: 'asking',
  current: null,
  values,
  skipped: [],
  returnToConfirm: false,
  awaitingFix: false,
  misses: 0,
});

/** Arranca: saluda y pregunta el primer campo pendiente. */
export function startVoice(
  def: VoiceDef,
  values: Record<string, string>,
  ctx: VoiceCtx,
): VoiceOutcome {
  const s = fresh(values);
  const first = nextPending(def, s);
  const hi =
    'Vamos a llenar el formulario. Di «repite», «salta», «atrás» o «cancela» cuando quieras.';
  return ask(def, s, first, ctx, hi);
}

/** Lo que se dice para volver a pedir lo que toca ahora. */
export function repeatPrompt(def: VoiceDef, state: VoiceState, ctx: VoiceCtx): string {
  if (state.phase === 'confirming') return confirm(state, def, ctx).say;
  const f = fieldOf(def, state.current);
  return f ? promptFor(f) : '';
}

export function currentField(def: VoiceDef, state: VoiceState): TrackerField | null {
  return fieldOf(def, state.current) ?? null;
}

// ---------------------------------------------------------------------------
// Aplicar valores
// ---------------------------------------------------------------------------

/**
 * Pone `value` en `key` si valida. Devuelve el estado nuevo o el mensaje del
 * error (para decirlo en voz alta y volver a pedir).
 */
function setValue(
  def: VoiceDef,
  state: VoiceState,
  key: string,
  value: string,
): { ok: true; state: VoiceState } | { ok: false; say: string } {
  const values = { ...state.values, [key]: value };
  const msg = violations(def, values)[key];
  if (msg) return { ok: false, say: msg };
  return {
    ok: true,
    state: { ...state, values, skipped: state.skipped.filter((k) => k !== key), misses: 0 },
  };
}

/** Después de llenar `key`: seguir con lo pendiente o volver al resumen. */
function afterFill(
  def: VoiceDef,
  state: VoiceState,
  key: string,
  ctx: VoiceCtx,
  lead: string,
): VoiceOutcome {
  if (state.returnToConfirm) {
    const still = nextPending(def, state, null);
    // Un showIf pudo abrir un campo nuevo al corregir: se pregunta antes del resumen.
    return still && !isScreenOnly(fieldOf(def, still) as TrackerField)
      ? ask(def, { ...state, returnToConfirm: true }, still, ctx, lead)
      : confirm({ ...state, returnToConfirm: false }, def, ctx, lead);
  }
  return ask(def, state, nextPending(def, state, key), ctx, lead);
}

function geolocate(def: VoiceDef, state: VoiceState, f: TrackerField): VoiceOutcome {
  return {
    state,
    say: `Buscando tu ubicación para ${label(f)}.`,
    effect: { type: 'geolocate', key: f.key },
  };
}

/** El navegador respondió a `geolocate`: un valor «lat,lng» o null si no se pudo. */
export function applyLocation(
  def: VoiceDef,
  state: VoiceState,
  key: string,
  value: string | null,
  ctx: VoiceCtx,
): VoiceOutcome {
  const f = fieldOf(def, key);
  if (!f) return { state, say: '' };
  if (!value) {
    if (f.required)
      return {
        state,
        say: `No pude tomar tu ubicación. Actívala en el navegador, o llénala en la pantalla. ${promptFor(f)}`,
      };
    const skipped = { ...state, skipped: [...state.skipped, key] };
    return afterFill(def, skipped, key, ctx, 'No pude tomar tu ubicación, la dejo vacía.');
  }
  const set = setValue(def, state, key, value);
  if (!set.ok) return { state, say: set.say };
  return afterFill(def, set.state, key, ctx, 'Ubicación puesta.');
}

// ---------------------------------------------------------------------------
// Comandos aplicados
// ---------------------------------------------------------------------------

function runCommand(
  def: VoiceDef,
  state: VoiceState,
  command: VoiceCommand,
  target: string | undefined,
  ctx: VoiceCtx,
): VoiceOutcome {
  const order = orderedKeys(def);
  switch (command) {
    case 'repeat':
      return { state, say: repeatPrompt(def, state, ctx) };
    case 'cancel':
      return {
        state: { ...state, phase: 'done' },
        say: 'Listo, no envié nada.',
        effect: { type: 'cancel' },
      };
    case 'read': {
      const body = summaryLine(def, state.values, ctx.today);
      const lead = body ? `Llevo: ${body}.` : 'Todavía no llevo nada.';
      return { state, say: join(lead, repeatPrompt(def, state, ctx)) };
    }
    case 'send': {
      const missing = missingRequired(def, state.values).filter((f) => !isScreenOnly(f));
      const first = missing[0];
      if (first && state.phase === 'asking')
        return ask(def, state, first.key, ctx, `Todavía falta ${label(first)}.`);
      return state.phase === 'confirming'
        ? { state, say: repeatPrompt(def, state, ctx) }
        : confirm(state, def, ctx);
    }
    case 'skip': {
      const f = fieldOf(def, state.current);
      if (!f) return { state, say: repeatPrompt(def, state, ctx) };
      if (f.required && !isScreenOnly(f))
        return { state, say: `«${label(f)}» es obligatorio, no se puede saltar. ${promptFor(f)}` };
      const s = { ...state, skipped: [...state.skipped, f.key], misses: 0 };
      return afterFill(def, s, f.key, ctx, '');
    }
    case 'back': {
      const visible = visibleSet(def, state.values);
      const at = state.current ? order.indexOf(state.current) : order.length;
      const prev = order
        .slice(0, Math.max(at, 0))
        .reverse()
        .find((k) => visible.has(k) && !isScreenOnly(fieldOf(def, k) as TrackerField));
      if (!prev)
        return { state, say: join('Estamos en el primero.', repeatPrompt(def, state, ctx)) };
      const f = fieldOf(def, prev) as TrackerField;
      return {
        state: {
          ...state,
          phase: 'asking',
          current: prev,
          skipped: state.skipped.filter((k) => k !== prev),
          awaitingFix: false,
        },
        say: join('Volvamos.', promptFor(f)),
      };
    }
    case 'correct': {
      const visible = visibleSet(def, state.values);
      const keys = order.filter(
        (k) => visible.has(k) && !isScreenOnly(fieldOf(def, k) as TrackerField),
      );
      const f = target ? findField(def, target, keys) : null;
      if (!f)
        return {
          state: { ...state, phase: 'confirming', current: null, awaitingFix: true },
          say: '¿Qué campo corrijo? Dime su nombre.',
        };
      return {
        state: {
          ...state,
          phase: 'asking',
          current: f.key,
          returnToConfirm: state.phase === 'confirming' || state.returnToConfirm,
          awaitingFix: false,
        },
        say: join(`Corrijamos ${label(f)}.`, promptFor(f)),
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Entradas del motor
// ---------------------------------------------------------------------------

function miss(def: VoiceDef, state: VoiceState, ctx: VoiceCtx): VoiceOutcome {
  const misses = state.misses + 1;
  const s = { ...state, misses };
  const prompt = repeatPrompt(def, s, ctx);
  return {
    state: s,
    say:
      misses >= 2
        ? join('Sigo sin entenderte.', 'Puedes escribirlo en la pantalla, o decir «salta».', prompt)
        : join('No te entendí.', prompt),
  };
}

/** Cuando el servidor no está (sin señal, sin plan, tope): se vuelve a preguntar. */
export function giveUp(
  def: VoiceDef,
  state: VoiceState,
  ctx: VoiceCtx,
  why?: string,
): VoiceOutcome {
  const out = miss(def, state, ctx);
  return why ? { ...out, say: join(why, repeatPrompt(def, out.state, ctx)) } : out;
}

/**
 * Procesa lo que la persona dijo. Con `server: true` la respuesta no era
 * simple: pregúntale al servidor y aplica con `applyServerTurn`.
 */
export function answer(
  def: VoiceDef,
  state: VoiceState,
  heard: string,
  ctx: VoiceCtx,
): VoiceOutcome {
  const text = heard.trim();
  if (!text) return miss(def, state, ctx);

  // En el resumen: sí envía, no pregunta qué corregir.
  if (state.phase === 'confirming') return answerConfirming(def, state, text, ctx);

  const cmd = parseCommand(text);
  const f = fieldOf(def, state.current);
  // «ninguno», «nada» en un checkbox son respuestas, no comandos.
  if (cmd && !(f?.type === 'checkbox' && cmd.command === 'skip' && isNo(text)))
    return runCommand(def, state, cmd.command, cmd.target, ctx);
  if (!f) return ask(def, state, nextPending(def, state), ctx);

  if (f.type === 'location') {
    if (isYes(text)) return geolocate(def, state, f);
    if (isNo(text)) return runCommand(def, state, 'skip', undefined, ctx);
    return miss(def, state, ctx);
  }

  const res = interpret(def, f, text, ctx);
  if (res.kind === 'unknown') return { state, say: '', server: true };
  if (res.kind === 'invalid') return { state, say: res.say };
  const set = setValue(def, state, f.key, res.value);
  if (!set.ok) return { state: { ...state, misses: 0 }, say: join(set.say, promptFor(f)) };
  return afterFill(def, set.state, f.key, ctx, '');
}

function answerConfirming(
  def: VoiceDef,
  state: VoiceState,
  text: string,
  ctx: VoiceCtx,
): VoiceOutcome {
  const cmd = parseCommand(text);
  if (cmd && cmd.command !== 'send') return runCommand(def, state, cmd.command, cmd.target, ctx);

  if (state.awaitingFix) {
    const visible = visibleSet(def, state.values);
    const keys = orderedKeys(def).filter(
      (k) => visible.has(k) && !isScreenOnly(fieldOf(def, k) as TrackerField),
    );
    const f = findField(def, text, keys);
    if (f) return runCommand(def, state, 'correct', label(f), ctx);
    if (isYes(text))
      return {
        state: { ...state, awaitingFix: false },
        say: repeatPrompt(def, { ...state, awaitingFix: false }, ctx),
      };
    return { state, say: 'No encontré ese campo. Dime su nombre, o di «enviar».' };
  }

  if (isYes(text) || cmd?.command === 'send') {
    const missing = missingRequired(def, state.values);
    if (missing.length)
      return {
        state,
        say: `Falta ${missing.map(label).join(', ')}: llénalo en la pantalla y di enviar.`,
      };
    const found = violations(def, state.values);
    const key = orderedKeys(def).find((k) => found[k]);
    if (key) {
      const f = fieldOf(def, key) as TrackerField;
      if (isScreenOnly(f))
        return { state, say: `${found[key]} Corrígelo en la pantalla y di enviar.` };
      return {
        state: {
          ...state,
          phase: 'asking',
          current: key,
          returnToConfirm: true,
          awaitingFix: false,
        },
        say: join(found[key], promptFor(f)),
      };
    }
    return { state: { ...state, phase: 'done' }, say: 'Enviando.', effect: { type: 'submit' } };
  }
  if (isNo(text))
    return { state: { ...state, awaitingFix: true }, say: '¿Qué campo corrijo? Dime su nombre.' };

  // «el peso está mal», «cambia las piezas»: nombra un campo.
  const visible = visibleSet(def, state.values);
  const f = findField(
    def,
    text,
    orderedKeys(def).filter(
      (k) => visible.has(k) && !isScreenOnly(fieldOf(def, k) as TrackerField),
    ),
  );
  if (f && words(fold(text)).length <= 6) return runCommand(def, state, 'correct', label(f), ctx);
  return {
    state,
    say: join('Dime sí para enviar, no para corregir algo, o cancela.', '¿Lo envío?'),
  };
}

/**
 * Aplica lo que el servidor leyó de una frase: valores para cualquier campo y,
 * si era un comando, cuál. Cada valor se valida con las reglas del campo; el
 * que no cumple se dice en voz alta y se vuelve a pedir.
 */
export function applyServerTurn(
  def: VoiceDef,
  state: VoiceState,
  turn: ServerTurn,
  ctx: VoiceCtx,
): VoiceOutcome {
  if (turn.command) {
    const target = turn.commandField ? fieldOf(def, turn.commandField)?.label : undefined;
    if (turn.command === 'correct' && target === undefined && turn.commandField)
      return runCommand(def, state, 'correct', undefined, ctx);
    return state.phase === 'confirming' && turn.command === 'send'
      ? answerConfirming(def, state, 'sí', ctx)
      : runCommand(def, state, turn.command, target, ctx);
  }
  if (state.phase === 'confirming') {
    // Algo dicho en el resumen que el motor no entendió: se lee como correcciones.
    if (!Object.keys(turn.values).length) return miss(def, state, ctx);
  }
  const visible = visibleSet(def, { ...state.values, ...turn.values });
  let s: VoiceState = state;
  const done: string[] = [];
  let lastKey = '';
  const errors: Array<{ key: string; say: string }> = [];
  for (const k of orderedKeys(def)) {
    const f = fieldOf(def, k);
    const raw = turn.values[k];
    if (!f || raw === undefined || blank(raw) || isScreenOnly(f) || !visible.has(k)) continue;
    const value =
      f.type === 'checkbox' ? (parseCheckbox(raw) === 0 ? '0' : '1') : String(raw).trim();
    const set = setValue(def, s, k, value);
    if (set.ok) {
      s = set.state;
      done.push(label(f));
      lastKey = k;
    } else errors.push({ key: k, say: set.say });
  }
  if (!done.length && !errors.length) return miss(def, state, ctx);

  const lead = done.length ? `Anoté ${done.join(', ')}.` : '';
  if (errors.length) {
    const first = errors[0] as { key: string; say: string };
    const f = fieldOf(def, first.key) as TrackerField;
    return {
      state: {
        ...s,
        phase: 'asking',
        current: first.key,
        returnToConfirm: state.phase === 'confirming' || state.returnToConfirm,
        misses: 0,
        awaitingFix: false,
      },
      say: join(lead, first.say, promptFor(f)),
    };
  }
  return afterFill(def, { ...s, phase: 'asking' }, lastKey, ctx, lead);
}

/** Para pruebas y para quien quiera saber si un número hablado es válido. */
export { parseSpokenNumber };

/** Si de verdad hay algo que preguntar (un formulario sólo de fotos no se conversa). */
export function canConverse(def: VoiceDef): boolean {
  return def.fields.some((f) => !isScreenOnly(f));
}

/** Los pasos visibles, por si quien llama quiere decir «paso 2 de 3». */
export function voiceSteps(def: VoiceDef, values: Record<string, string>) {
  if (!def.steps?.length) return null;
  const all = stepFields(
    def.steps as never,
    def.fields.map((f) => f.key),
  );
  return visibleSteps(all, visibleSet(def, values));
}
