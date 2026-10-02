/**
 * EL SELECTOR DE HORARIOS, SIN REACT.
 *
 * Una rutina se guarda como una expresión cron de 5 campos más una zona
 * horaria IANA (o, si corre una sola vez, como un instante `run_at`). Nadie
 * debería tener que escribir «0 9 * * 1-5» para decir «días hábiles a las 9».
 * Este módulo traduce en las dos direcciones:
 *
 *   - `pickerToCron` arma la expresión a partir de lo que se eligió.
 *   - `cronToPicker` lee una expresión guardada de vuelta al selector, o
 *     devuelve `null` si no cabe en él (y la pantalla abre «Avanzado»).
 *   - `describe` / `describeCron` la dicen en una frase en español.
 *   - `nextRuns` calcula las próximas ejecuciones en la zona elegida.
 *
 * WHY A HAND-ROLLED EVALUATOR. `cron-parser` vive en @cortex/agent-tools, que
 * un componente cliente no puede importar (arrastra node:crypto y compañía),
 * y no está en las dependencias de apps/web. Para mostrar «las próximas 3
 * veces» basta con un evaluador pequeño de la sintaxis estándar (números,
 * rangos, pasos, listas y nombres). La autoridad sigue siendo el servidor:
 * PATCH /api/schedules/[id] valida con cron-parser antes de guardar, y si este
 * evaluador no entiende algo exótico (L, W, #) sólo deja de mostrar la vista
 * previa — no impide guardar.
 *
 * Puro y sin dependencias: lo importan componentes cliente, la página del
 * servidor y las pruebas.
 */

export type PickerMode = 'daily' | 'weekdays' | 'days' | 'weekly' | 'monthly' | 'hourly' | 'once';

export interface SchedulePicker {
  mode: PickerMode;
  /** Hora local `HH:MM` (24 h). En `hourly` sólo cuentan los minutos. */
  time: string;
  /** Días elegidos en `days`: 0 = domingo … 6 = sábado. */
  days: number[];
  /** Día de `weekly`: 0 = domingo … 6 = sábado. */
  weekday: number;
  /** Día de `monthly`: 1 … 31. */
  monthDay: number;
  /** Intervalo de `hourly`, en horas. Sólo divisores de 24 (ver HOUR_STEPS). */
  everyHours: number;
  /** Fecha local `YYYY-MM-DD` de `once`. */
  date: string;
}

export const DEFAULT_TIMEZONE = 'America/Bogota';

/** Intervalos que reparten el día parejo: cada 5 h dejaría un hueco de 4 h a medianoche. */
export const HOUR_STEPS = [1, 2, 3, 4, 6, 8, 12] as const;

export const DEFAULT_PICKER: SchedulePicker = {
  mode: 'daily',
  time: '09:00',
  days: [1, 3, 5],
  weekday: 1,
  monthDay: 1,
  everyHours: 2,
  date: '',
};

export const MODE_LABEL: Record<PickerMode, string> = {
  daily: 'Cada día',
  weekdays: 'Días hábiles',
  days: 'Ciertos días',
  weekly: 'Cada semana',
  monthly: 'Cada mes',
  hourly: 'Cada X horas',
  once: 'Una sola vez',
};

/** Chips L M X J V S D, en el orden en que se lee la semana (lunes primero). */
export const WEEK_CHIPS: ReadonlyArray<{ day: number; short: string; name: string }> = [
  { day: 1, short: 'L', name: 'lunes' },
  { day: 2, short: 'M', name: 'martes' },
  { day: 3, short: 'X', name: 'miércoles' },
  { day: 4, short: 'J', name: 'jueves' },
  { day: 5, short: 'V', name: 'viernes' },
  { day: 6, short: 'S', name: 'sábado' },
  { day: 0, short: 'D', name: 'domingo' },
];

export const DAY_NAME = [
  'domingo',
  'lunes',
  'martes',
  'miércoles',
  'jueves',
  'viernes',
  'sábado',
] as const;

const MONTH_NAME = [
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
] as const;

// ---------------------------------------------------------------------------
// Zonas horarias
// ---------------------------------------------------------------------------

/** Las zonas de quienes usan Cortex: Latinoamérica, EE. UU. y España. */
export const COMMON_TIMEZONES: ReadonlyArray<{ tz: string; label: string }> = [
  { tz: 'America/Bogota', label: 'Hora de Colombia' },
  { tz: 'America/Mexico_City', label: 'Hora de México (Ciudad de México)' },
  { tz: 'America/Lima', label: 'Hora de Perú' },
  { tz: 'America/Guayaquil', label: 'Hora de Ecuador' },
  { tz: 'America/Panama', label: 'Hora de Panamá' },
  { tz: 'America/Caracas', label: 'Hora de Venezuela' },
  { tz: 'America/Santiago', label: 'Hora de Chile' },
  { tz: 'America/Argentina/Buenos_Aires', label: 'Hora de Argentina' },
  { tz: 'America/Montevideo', label: 'Hora de Uruguay' },
  { tz: 'America/Asuncion', label: 'Hora de Paraguay' },
  { tz: 'America/La_Paz', label: 'Hora de Bolivia' },
  { tz: 'America/Sao_Paulo', label: 'Hora de Brasil (São Paulo)' },
  { tz: 'America/Costa_Rica', label: 'Hora de Costa Rica' },
  { tz: 'America/Guatemala', label: 'Hora de Guatemala' },
  { tz: 'America/El_Salvador', label: 'Hora de El Salvador' },
  { tz: 'America/Tegucigalpa', label: 'Hora de Honduras' },
  { tz: 'America/Managua', label: 'Hora de Nicaragua' },
  { tz: 'America/Santo_Domingo', label: 'Hora de República Dominicana' },
  { tz: 'America/Puerto_Rico', label: 'Hora de Puerto Rico' },
  { tz: 'America/Cancun', label: 'Hora de México (Cancún)' },
  { tz: 'America/Tijuana', label: 'Hora de México (Tijuana)' },
  { tz: 'America/New_York', label: 'Hora del Este de EE. UU. (Nueva York, Miami)' },
  { tz: 'America/Chicago', label: 'Hora del Centro de EE. UU. (Chicago, Houston)' },
  { tz: 'America/Denver', label: 'Hora de la Montaña de EE. UU. (Denver)' },
  { tz: 'America/Phoenix', label: 'Hora de Arizona' },
  { tz: 'America/Los_Angeles', label: 'Hora del Pacífico de EE. UU. (Los Ángeles)' },
  { tz: 'Europe/Madrid', label: 'Hora de España (Madrid)' },
  { tz: 'Atlantic/Canary', label: 'Hora de Canarias' },
  { tz: 'UTC', label: 'Hora universal (UTC)' },
];

/** «Hora de Colombia» para America/Bogota; el nombre IANA legible para el resto. */
export function tzLabel(tz: string): string {
  const known = COMMON_TIMEZONES.find((z) => z.tz === tz);
  if (known) return known.label;
  return tz.replace(/_/g, ' ');
}

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Busca sin tildes ni mayúsculas en la etiqueta y en el nombre IANA. */
export function searchTimezones(query: string): Array<{ tz: string; label: string }> {
  const fold = (s: string) =>
    s
      .normalize('NFD')
      // biome-ignore lint/suspicious/noMisleadingCharacterClass: BMP-only combining range
      .replace(/[̀-ͯ]/gu, '')
      .toLowerCase();
  const q = fold(query.trim());
  if (!q) return [...COMMON_TIMEZONES];
  return COMMON_TIMEZONES.filter((z) => fold(`${z.label} ${z.tz.replace(/_/g, ' ')}`).includes(q));
}

// ---------------------------------------------------------------------------
// Picker ⇄ cron
// ---------------------------------------------------------------------------

function parseTime(time: string): { hour: number; minute: number } | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** Días únicos, válidos y en orden 0…6. */
function normalizeDays(days: number[]): number[] {
  return [...new Set(days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort(
    (a, b) => a - b,
  );
}

/**
 * La expresión de 5 campos para lo elegido. `null` para `once` (no es cron:
 * se guarda como instante) y para un selector incompleto o inválido.
 */
export function pickerToCron(picker: SchedulePicker): string | null {
  const t = parseTime(picker.time);
  if (!t) return null;
  const { hour, minute } = t;
  switch (picker.mode) {
    case 'daily':
      return `${minute} ${hour} * * *`;
    case 'weekdays':
      return `${minute} ${hour} * * 1-5`;
    case 'days': {
      const days = normalizeDays(picker.days);
      if (days.length === 0) return null;
      if (days.length === 7) return `${minute} ${hour} * * *`;
      return `${minute} ${hour} * * ${days.join(',')}`;
    }
    case 'weekly': {
      const d = picker.weekday;
      if (!Number.isInteger(d) || d < 0 || d > 6) return null;
      return `${minute} ${hour} * * ${d}`;
    }
    case 'monthly': {
      const d = picker.monthDay;
      if (!Number.isInteger(d) || d < 1 || d > 31) return null;
      return `${minute} ${hour} ${d} * *`;
    }
    case 'hourly': {
      const step = picker.everyHours;
      if (!(HOUR_STEPS as readonly number[]).includes(step)) return null;
      return step === 1 ? `${minute} * * * *` : `${minute} */${step} * * *`;
    }
    case 'once':
      return null;
  }
}

const DOW_NAMES: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};
const MONTH_NAMES: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

/**
 * Lee una expresión guardada de vuelta al selector. `null` cuando no cabe en
 * él (cada 15 minutos, sólo en marzo, horas sueltas…): la pantalla muestra
 * entonces el campo avanzado con la expresión tal cual.
 */
export function cronToPicker(cron: string | null | undefined): SchedulePicker | null {
  if (!cron) return null;
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minF, hourF, domF, monF, dowF] = parts as [string, string, string, string, string];
  if (monF !== '*') return null;
  if (!/^\d{1,2}$/.test(minF)) return null;
  const minute = Number(minF);
  if (minute > 59) return null;

  // Cada X horas: «M * * * *» o «M */X * * *», sin día ni mes.
  if (hourF === '*' || /^\*\/\d{1,2}$/.test(hourF) || /^0-23\/\d{1,2}$/.test(hourF)) {
    if (domF !== '*' || (dowF !== '*' && dowF !== '?')) return null;
    const step = hourF === '*' ? 1 : Number(hourF.split('/')[1]);
    if (!(HOUR_STEPS as readonly number[]).includes(step)) return null;
    return { ...DEFAULT_PICKER, mode: 'hourly', everyHours: step, time: `00:${pad(minute)}` };
  }

  if (!/^\d{1,2}$/.test(hourF)) return null;
  const hour = Number(hourF);
  if (hour > 23) return null;
  const time = `${pad(hour)}:${pad(minute)}`;
  const dowAny = dowF === '*' || dowF === '?';
  const domAny = domF === '*' || domF === '?';

  if (domAny && dowAny) return { ...DEFAULT_PICKER, mode: 'daily', time };

  if (!domAny) {
    if (!dowAny || !/^\d{1,2}$/.test(domF)) return null;
    const day = Number(domF);
    if (day < 1 || day > 31) return null;
    return { ...DEFAULT_PICKER, mode: 'monthly', time, monthDay: day };
  }

  const days = parseDowList(dowF);
  if (!days) return null;
  if (days.length === 7) return { ...DEFAULT_PICKER, mode: 'daily', time };
  if (days.join(',') === '1,2,3,4,5') return { ...DEFAULT_PICKER, mode: 'weekdays', time };
  if (days.length === 1)
    return { ...DEFAULT_PICKER, mode: 'weekly', time, weekday: days[0] as number };
  return { ...DEFAULT_PICKER, mode: 'days', time, days };
}

/** «1-5», «1,3,5», «MON-FRI», «7» → días 0…6 ordenados. Sin pasos: esos van a «Avanzado». */
function parseDowList(field: string): number[] | null {
  const out = new Set<number>();
  const one = (token: string): number | null => {
    const t = token.toLowerCase();
    if (t in DOW_NAMES) return DOW_NAMES[t] as number;
    if (!/^\d$/.test(t)) return null;
    const n = Number(t);
    if (n > 7) return null;
    return n === 7 ? 0 : n;
  };
  for (const piece of field.split(',')) {
    if (!piece) return null;
    const range = piece.split('-');
    if (range.length === 1) {
      const n = one(piece);
      if (n === null) return null;
      out.add(n);
    } else if (range.length === 2) {
      const a = one(range[0] as string);
      // «5-7» acaba en domingo: 7 como fin de rango vale 7, no 0.
      const bRaw = (range[1] as string).toLowerCase();
      const b = bRaw === '7' ? 7 : one(bRaw);
      if (a === null || b === null || b < a) return null;
      for (let d = a; d <= b; d++) out.add(d === 7 ? 0 : d);
    } else return null;
  }
  return [...out].sort((x, y) => x - y);
}

// ---------------------------------------------------------------------------
// Frases
// ---------------------------------------------------------------------------

/** `09:00` → «9:00 a. m.»; `13:30` → «1:30 p. m.»; `00:00` → «12:00 a. m.». */
export function formatTime12(time: string): string {
  const t = parseTime(time);
  if (!t) return time;
  const suffix = t.hour < 12 ? 'a. m.' : 'p. m.';
  const h12 = t.hour % 12 === 0 ? 12 : t.hour % 12;
  return `${h12}:${pad(t.minute)} ${suffix}`;
}

function joinEs(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} y ${items[items.length - 1]}`;
}

function plural(name: string): string {
  // «sábado» → «sábados»; «lunes» ya es plural.
  return name.endsWith('s') ? name : `${name}s`;
}

/** Fecha local `YYYY-MM-DD` → «viernes 3 de octubre de 2026». */
export function formatDateLong(date: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return date;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dow = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
  return `${DAY_NAME[dow]} ${d} de ${MONTH_NAME[mo - 1]} de ${y}`;
}

/**
 * Lo elegido, dicho en una frase: «De lunes a viernes a las 8:00 a. m.».
 * No incluye la zona: quien la muestra decide si añadir «· Hora de Colombia».
 */
export function describe(picker: SchedulePicker): string {
  const at = `a las ${formatTime12(picker.time)}`;
  switch (picker.mode) {
    case 'daily':
      return `Todos los días ${at}`;
    case 'weekdays':
      return `De lunes a viernes ${at}`;
    case 'days': {
      const days = normalizeDays(picker.days);
      if (days.length === 0) return 'Elige al menos un día';
      if (days.length === 7) return `Todos los días ${at}`;
      // En el orden de la semana que se lee: lunes primero, domingo al final.
      const ordered = WEEK_CHIPS.filter((c) => days.includes(c.day)).map((c) => plural(c.name));
      return `Los ${joinEs(ordered)} ${at}`;
    }
    case 'weekly':
      return `Cada ${DAY_NAME[picker.weekday] ?? '—'} ${at}`;
    case 'monthly': {
      const base = `El día ${picker.monthDay} de cada mes ${at}`;
      return picker.monthDay > 28 ? `${base} (los meses que no tienen ese día se saltan)` : base;
    }
    case 'hourly': {
      const t = parseTime(picker.time);
      const minute = t?.minute ?? 0;
      const when = minute === 0 ? 'en punto' : `en el minuto ${pad(minute)}`;
      return picker.everyHours === 1
        ? `Cada hora, ${when}`
        : `Cada ${picker.everyHours} horas, ${when} (desde la medianoche)`;
    }
    case 'once':
      return picker.date
        ? `Una sola vez, el ${formatDateLong(picker.date)} ${at}`
        : 'Una sola vez: elige la fecha';
  }
}

/**
 * Una expresión guardada en palabras. Usa el selector cuando cabe; si no,
 * reconoce «cada N minutos» y si tampoco, devuelve la expresión tal cual.
 */
export function describeCron(cron: string | null | undefined): string {
  if (!cron) return '—';
  const picker = cronToPicker(cron);
  if (picker) return describe(picker);
  const parts = cron.trim().split(/\s+/);
  if (parts.length === 5) {
    const [min, hour, dom, mon, dow] = parts as [string, string, string, string, string];
    if (/^\*\/\d+$/.test(min) && hour === '*' && dom === '*' && mon === '*' && dow === '*')
      return `Cada ${min.slice(2)} minutos`;
  }
  return `Expresión cron «${cron.trim()}»`;
}

// ---------------------------------------------------------------------------
// Zonas horarias: de pared a instante y de vuelta
// ---------------------------------------------------------------------------

interface WallTime {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  dow: number; // 0-6
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatterFor(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
    });
    formatters.set(tz, f);
  }
  return f;
}

/** El reloj de pared de `date` en `tz`. */
export function wallTimeIn(date: Date, tz: string): WallTime {
  const parts = formatterFor(tz).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const weekday = get('weekday').toLowerCase().slice(0, 3);
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')) % 24,
    minute: Number(get('minute')),
    dow: DOW_NAMES[weekday] ?? 0,
  };
}

/** Minutos que `tz` va por delante de UTC en el instante `ms`. */
function offsetMinutes(ms: number, tz: string): number {
  const w = wallTimeIn(new Date(ms), tz);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute);
  const floored = Math.floor(ms / 60_000) * 60_000;
  return Math.round((asUtc - floored) / 60_000);
}

/**
 * El instante en que el reloj de `tz` marca esa fecha y hora. `null` si esa
 * hora no existe allí (el salto de un cambio de horario).
 */
export function zonedToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  tz: string,
): Date | null {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  let ms = guess - offsetMinutes(guess, tz) * 60_000;
  const second = guess - offsetMinutes(ms, tz) * 60_000;
  if (second !== ms) ms = second;
  const back = wallTimeIn(new Date(ms), tz);
  if (
    back.year !== year ||
    back.month !== month ||
    back.day !== day ||
    back.hour !== hour ||
    back.minute !== minute
  )
    return null;
  return new Date(ms);
}

/** `once` → ISO del instante, o `null` si falta la fecha o la hora. */
export function onceToRunAt(picker: SchedulePicker, tz: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(picker.date);
  const t = parseTime(picker.time);
  if (!m || !t) return null;
  const at = zonedToUtc(Number(m[1]), Number(m[2]), Number(m[3]), t.hour, t.minute, tz);
  return at ? at.toISOString() : null;
}

/** Un `run_at` guardado de vuelta al selector, leído en la zona de la rutina. */
export function runAtToPicker(runAt: string | null | undefined, tz: string): SchedulePicker | null {
  if (!runAt) return null;
  const d = new Date(runAt);
  if (!Number.isFinite(d.getTime())) return null;
  const w = wallTimeIn(d, tz);
  return {
    ...DEFAULT_PICKER,
    mode: 'once',
    date: `${w.year}-${pad(w.month)}-${pad(w.day)}`,
    time: `${pad(w.hour)}:${pad(w.minute)}`,
  };
}

// ---------------------------------------------------------------------------
// Evaluador de cron
// ---------------------------------------------------------------------------

interface CronSpec {
  minutes: number[];
  hours: number[];
  doms: Set<number>;
  months: Set<number>;
  dows: Set<number>;
  domAny: boolean;
  dowAny: boolean;
}

function parseField(
  field: string,
  min: number,
  max: number,
  names?: Record<string, number>,
): Set<number> | null {
  const out = new Set<number>();
  const value = (token: string): number | null => {
    const t = token.toLowerCase();
    if (names && t in names) return names[t] as number;
    if (!/^\d+$/.test(t)) return null;
    return Number(t);
  };
  for (const piece of field.split(',')) {
    if (!piece) return null;
    const [rangePart, stepPart, ...rest] = piece.split('/');
    if (rest.length > 0 || rangePart === undefined) return null;
    let step = 1;
    if (stepPart !== undefined) {
      if (!/^\d+$/.test(stepPart)) return null;
      step = Number(stepPart);
      if (step < 1) return null;
    }
    let lo: number;
    let hi: number;
    if (rangePart === '*' || rangePart === '?') {
      lo = min;
      hi = max;
    } else if (rangePart.includes('-')) {
      const [a, b, ...more] = rangePart.split('-');
      if (more.length > 0 || a === undefined || b === undefined) return null;
      const va = value(a);
      const vb = value(b);
      if (va === null || vb === null) return null;
      lo = va;
      hi = vb;
    } else {
      const v = value(rangePart);
      if (v === null) return null;
      lo = v;
      // «5/15» = desde 5 hasta el final, de 15 en 15.
      hi = stepPart !== undefined ? max : v;
    }
    if (lo < min || hi > max || lo > hi) return null;
    for (let n = lo; n <= hi; n += step) out.add(n);
  }
  return out;
}

/** La expresión entendida, o `null` si este evaluador no la reconoce. */
export function parseCronSpec(cron: string): CronSpec | null {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minF, hourF, domF, monF, dowF] = parts as [string, string, string, string, string];
  const minutes = parseField(minF, 0, 59);
  const hours = parseField(hourF, 0, 23);
  const doms = parseField(domF, 1, 31);
  const months = parseField(monF, 1, 12, MONTH_NAMES);
  const dowsRaw = parseField(dowF, 0, 7, DOW_NAMES);
  if (!minutes || !hours || !doms || !months || !dowsRaw) return null;
  const dows = new Set([...dowsRaw].map((d) => (d === 7 ? 0 : d)));
  return {
    minutes: [...minutes].sort((a, b) => a - b),
    hours: [...hours].sort((a, b) => a - b),
    doms,
    months,
    dows,
    domAny: domF === '*' || domF === '?',
    dowAny: dowF === '*' || dowF === '?',
  };
}

function dayMatches(spec: CronSpec, month: number, dom: number, dow: number): boolean {
  if (!spec.months.has(month)) return false;
  // Regla de Vixie cron (y de cron-parser): si se restringen el día del mes y
  // el de la semana a la vez, basta con que coincida uno de los dos.
  if (!spec.domAny && !spec.dowAny) return spec.doms.has(dom) || spec.dows.has(dow);
  return spec.doms.has(dom) && spec.dows.has(dow);
}

/**
 * Las próximas `count` ejecuciones de `cron` en `tz`, estrictamente después
 * de `from`. Lista vacía si la expresión no se entiende o nunca coincide
 * (por ejemplo, el 31 de febrero) en los próximos ocho años.
 */
export function nextRuns(cron: string, tz: string, from: Date = new Date(), count = 3): Date[] {
  const spec = parseCronSpec(cron);
  if (!spec || !isValidTimezone(tz)) return [];
  const out: Date[] = [];
  const start = wallTimeIn(from, tz);
  const fromMs = from.getTime();
  // Recorre días del calendario local; en cada uno, sus horas y minutos.
  for (let i = 0; i < 366 * 8 && out.length < count; i++) {
    const day = new Date(Date.UTC(start.year, start.month - 1, start.day + i));
    const y = day.getUTCFullYear();
    const mo = day.getUTCMonth() + 1;
    const d = day.getUTCDate();
    if (!dayMatches(spec, mo, d, day.getUTCDay())) continue;
    for (const h of spec.hours) {
      if (i === 0 && h < start.hour) continue;
      for (const m of spec.minutes) {
        const at = zonedToUtc(y, mo, d, h, m, tz);
        if (!at || at.getTime() <= fromMs) continue;
        out.push(at);
        if (out.length >= count) return out;
      }
    }
  }
  return out;
}

/** Las próximas ejecuciones de lo elegido (para `once`, su único instante si es futuro). */
export function nextRunsForPicker(
  picker: SchedulePicker,
  tz: string,
  from: Date = new Date(),
  count = 3,
): Date[] {
  if (picker.mode === 'once') {
    const iso = onceToRunAt(picker, tz);
    if (!iso) return [];
    const at = new Date(iso);
    return at.getTime() > from.getTime() ? [at] : [];
  }
  const cron = pickerToCron(picker);
  return cron ? nextRuns(cron, tz, from, count) : [];
}

/** «vie 3 oct, 9:00 a. m.» en la zona de la rutina. */
export function formatRun(date: Date, tz: string): string {
  const w = wallTimeIn(date, tz);
  const dow = DAY_NAME[w.dow]?.slice(0, 3) ?? '';
  const month = MONTH_NAME[w.month - 1]?.slice(0, 3) ?? '';
  return `${dow} ${w.day} ${month}, ${formatTime12(`${pad(w.hour)}:${pad(w.minute)}`)}`;
}

/** La fecha local de hoy en `tz`, como `YYYY-MM-DD` (para el mínimo del calendario). */
export function todayIn(tz: string, now: Date = new Date()): string {
  const w = wallTimeIn(now, tz);
  return `${w.year}-${pad(w.month)}-${pad(w.day)}`;
}

// ---------------------------------------------------------------------------
// El borrador de un formulario: selector + campo avanzado + zona
// ---------------------------------------------------------------------------

/**
 * Lo que un formulario de horario tiene en la mano. `custom` dice quién manda:
 * `false` → el selector (y `rawCron` es su reflejo), `true` → la expresión
 * escrita a mano, que no cabe en el selector.
 */
export interface ScheduleDraft {
  picker: SchedulePicker;
  rawCron: string;
  custom: boolean;
  timezone: string;
}

export type ResolvedSchedule =
  | { ok: true; kind: 'cron'; cron: string }
  | { ok: true; kind: 'once'; runAt: string }
  | { ok: false; error: string };

/** El borrador para una rutina guardada (o uno nuevo si no hay nada). */
export function draftFromSchedule(saved: {
  scheduleKind?: 'once' | 'cron' | null;
  cron?: string | null;
  runAt?: string | null;
  timezone?: string | null;
}): ScheduleDraft {
  const timezone =
    saved.timezone && isValidTimezone(saved.timezone) ? saved.timezone : DEFAULT_TIMEZONE;
  if (saved.scheduleKind === 'once') {
    const picker = runAtToPicker(saved.runAt, timezone) ?? { ...DEFAULT_PICKER, mode: 'once' };
    return { picker, rawCron: '', custom: false, timezone };
  }
  const cron = saved.cron?.trim() ?? '';
  if (!cron) {
    return {
      picker: DEFAULT_PICKER,
      rawCron: pickerToCron(DEFAULT_PICKER) ?? '',
      custom: false,
      timezone,
    };
  }
  const picker = cronToPicker(cron);
  return picker
    ? { picker, rawCron: cron, custom: false, timezone }
    : { picker: DEFAULT_PICKER, rawCron: cron, custom: true, timezone };
}

/** Se movió el selector: él vuelve a mandar y el campo avanzado lo refleja. */
export function withPicker(draft: ScheduleDraft, picker: SchedulePicker): ScheduleDraft {
  const cron = pickerToCron(picker);
  return { ...draft, picker, custom: false, rawCron: cron ?? draft.rawCron };
}

/** Se escribió en «Avanzado»: si cabe en el selector, el selector la sigue. */
export function withRawCron(draft: ScheduleDraft, rawCron: string): ScheduleDraft {
  const picker = cronToPicker(rawCron);
  return picker
    ? { ...draft, rawCron, picker, custom: false }
    : { ...draft, rawCron, custom: true };
}

/** Lo que se guarda. Los errores ya vienen en palabras para mostrarlos. */
export function resolveDraft(draft: ScheduleDraft, now: Date = new Date()): ResolvedSchedule {
  if (!isValidTimezone(draft.timezone)) {
    return { ok: false, error: 'Esa zona horaria no existe. Elige una de la lista.' };
  }
  if (draft.custom) {
    const cron = draft.rawCron.trim().replace(/\s+/g, ' ');
    if (cron.split(' ').length !== 5) {
      return {
        ok: false,
        error: 'La expresión cron necesita exactamente 5 campos, por ejemplo «0 9 * * 1-5».',
      };
    }
    return { ok: true, kind: 'cron', cron };
  }
  const { picker } = draft;
  if (picker.mode === 'once') {
    const runAt = onceToRunAt(picker, draft.timezone);
    if (!runAt) return { ok: false, error: 'Elige la fecha y la hora en que debe correr.' };
    if (new Date(runAt).getTime() <= now.getTime()) {
      return { ok: false, error: 'Esa fecha y hora ya pasaron. Elige un momento futuro.' };
    }
    return { ok: true, kind: 'once', runAt };
  }
  const cron = pickerToCron(picker);
  if (!cron) {
    return {
      ok: false,
      error:
        picker.mode === 'days'
          ? 'Elige al menos un día de la semana.'
          : 'Revisa la hora: el horario está incompleto.',
    };
  }
  return { ok: true, kind: 'cron', cron };
}

/** La frase del borrador, con la expresión cruda cuando manda «Avanzado». */
export function describeDraft(draft: ScheduleDraft): string {
  return draft.custom ? describeCron(draft.rawCron) : describe(draft.picker);
}

/** Próximas ejecuciones del borrador, sea cual sea quien manda. */
export function nextRunsForDraft(draft: ScheduleDraft, from: Date = new Date(), count = 3): Date[] {
  if (draft.custom) return nextRuns(draft.rawCron, draft.timezone, from, count);
  return nextRunsForPicker(draft.picker, draft.timezone, from, count);
}
