/**
 * UN SOLO FORMATEADOR DE CIFRAS Y FECHAS (es-CO, hora de Bogotá).
 *
 * Todo lo que una persona LEE (tablas, tarjetas, métricas, ejes y tooltips de
 * gráficos, detalle, avisos, correos de reportes, PDF, chat) pasa por aquí, y
 * lo que se EXPORTA a CSV/Excel usa `parseNumber` para guardar números reales.
 * Archivo hoja, sin dependencias: lo usan el servidor, el navegador y la
 * grilla (`apps/web/lib/datagrid/format.ts` lo reexporta).
 *
 * Reglas:
 *   - dinero en pesos completos («$ 1.250.000»); sólo desde mil millones se
 *     abrevia («$ 1,6 mil millones»). USD con dos decimales («US$ 1.250,50»).
 *   - negativos con signo claro («-$ 25.000»), nunca entre paréntesis.
 *   - jamás «NaN», «undefined», «null» ni una fecha ISO cruda a la vista: lo
 *     que no se entiende sale como «—» (o tal cual si es texto de una persona).
 *   - `date` es un día `YYYY-MM-DD` sin zona; `datetime` es un ISO que se
 *     muestra en hora de Bogotá.
 */

export const TIME_ZONE = 'America/Bogota';

export const COLLATOR = new Intl.Collator('es', { sensitivity: 'base', numeric: true });

/** Minúsculas y sin tildes: «Bogotá» y «bogota» son la misma búsqueda. */
export function foldText(value: string): string {
  return value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();
}

export function isEmptyValue(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'number') return Number.isNaN(value);
  return false;
}

// ---------------------------------------------------------------------------
// Números
// ---------------------------------------------------------------------------

/**
 * Un número escrito como lo escribe una persona en Colombia, o como lo manda
 * una máquina. «1.250.000», «1250000», «$ 1.250.000,50», «12,5», «12.5 %».
 *
 * La regla del punto: un punto seguido de exactamente tres cifras, y sin coma
 * en el texto, es separador de miles («1.500» = 1500); cualquier otro punto
 * solo es decimal («2.5»). La coma siempre es decimal.
 */
export function parseNumber(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== 'string') return null;
  let s = raw.trim().replace(/[\s $%]|COP|USD|EUR/gi, '');
  if (!s) return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  if (s.startsWith('-')) {
    negative = !negative;
    s = s.slice(1);
  } else if (s.startsWith('+')) s = s.slice(1);
  if (!/^[\d.,]+$/.test(s)) return null;
  const hasComma = s.includes(',');
  const dots = (s.match(/\./g) ?? []).length;
  if (hasComma) {
    const lastComma = s.lastIndexOf(',');
    const lastDot = s.lastIndexOf('.');
    if (lastDot > lastComma) {
      // «1,250,000.50»: estilo inglés.
      s = s.replace(/,/g, '');
    } else {
      s = s.replace(/\./g, '').replace(',', '.');
      if (s.includes(',')) return null;
    }
  } else if (dots > 1) {
    if (!/^\d{1,3}(\.\d{3})+$/.test(s)) return null;
    s = s.replace(/\./g, '');
  } else if (dots === 1 && /^\d{1,3}\.\d{3}$/.test(s)) {
    s = s.replace('.', '');
  }
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

const numberFormats = new Map<string, Intl.NumberFormat>();
function nf(key: string, make: () => Intl.NumberFormat): Intl.NumberFormat {
  let f = numberFormats.get(key);
  if (!f) {
    f = make();
    numberFormats.set(key, f);
  }
  return f;
}

export function formatNumber(n: number, maxDecimals = 2): string {
  if (!Number.isFinite(n)) return DASH;
  return nf(`n${maxDecimals}`, () =>
    Intl.NumberFormat('es-CO', { maximumFractionDigits: maxDecimals }),
  ).format(n);
}

export function formatMoney(n: number, currency = 'COP'): string {
  if (!Number.isFinite(n)) return DASH;
  const code = /^[A-Z]{3}$/.test(currency) ? currency : 'COP';
  const decimals = code === 'COP' ? 0 : 2;
  // «-$ 0» no existe: lo que redondea a cero se ve cero, sin signo.
  const f = 10 ** decimals;
  if (Math.round(n * f) === 0) n = 0;
  return nf(`m${code}`, () =>
    Intl.NumberFormat('es-CO', {
      style: 'currency',
      currency: code,
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    }),
  ).format(n);
}

/** Cifras grandes en poco espacio: «$ 12.400.000» completo y «$ 1,6 mil millones» desde mil millones. Para totales en tarjetas. */
export function formatCompactMoney(n: number, currency = 'COP'): string {
  if (!Number.isFinite(n)) return DASH;
  const abs = Math.abs(n);
  // Pesos completos; sólo desde mil millones se abrevia (regla del dueño).
  if (abs < 1_000_000_000) return formatMoney(n, currency);
  const sign = n < 0 ? '-' : '';
  const symbol = currency === 'COP' ? '$' : currency;
  return `${sign}${symbol} ${formatNumber(abs / 1_000_000_000, 1)} mil millones`;
}

export function formatPercent(n: number): string {
  if (!Number.isFinite(n)) return DASH;
  return `${formatNumber(n, 1)} %`;
}

// ---------------------------------------------------------------------------
// Fechas
// ---------------------------------------------------------------------------

export const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function validDay(y: number, m: number, d: number): boolean {
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** El día de Bogotá de un instante, como `YYYY-MM-DD`. */
export function bogotaDay(date: Date): string {
  return date.toLocaleDateString('en-CA', { timeZone: TIME_ZONE });
}

/**
 * El día que representa un valor: un `YYYY-MM-DD` tal cual, un ISO con hora
 * en el día de Bogotá, `null` si no es una fecha.
 */
export function dayKey(value: unknown): string | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : bogotaDay(value);
  if (typeof value !== 'string') return null;
  const s = value.trim();
  const m = DAY_RE.exec(s);
  if (m) return validDay(Number(m[1]), Number(m[2]), Number(m[3])) ? s : null;
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : bogotaDay(d);
  }
  return null;
}

/** Milisegundos para ordenar: un día a mediodía UTC, un ISO tal cual. */
export function timeValue(value: unknown): number | null {
  if (typeof value !== 'string' && !(value instanceof Date)) return null;
  if (typeof value === 'string' && DAY_RE.test(value.trim())) {
    const key = dayKey(value);
    return key ? Date.parse(`${key}T12:00:00Z`) : null;
  }
  const t = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

export function addDays(day: string, n: number): string {
  const m = DAY_RE.exec(day);
  if (!m) return day;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + n));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

const dateFormats = new Map<string, Intl.DateTimeFormat>();
function df(key: string, make: () => Intl.DateTimeFormat): Intl.DateTimeFormat {
  let f = dateFormats.get(key);
  if (!f) {
    f = make();
    dateFormats.set(key, f);
  }
  return f;
}

export const MONTHS_SHORT = [
  'ene',
  'feb',
  'mar',
  'abr',
  'may',
  'jun',
  'jul',
  'ago',
  'sep',
  'oct',
  'nov',
  'dic',
];
export const MONTHS_LONG = [
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

/**
 * «2 oct 2026». Armado a mano y no con `Intl`: cada versión de ICU escribe
 * es-CO distinto («2 de oct. de 2026»), y una celda no puede cambiar de forma
 * según el navegador de quien la mira.
 */
export function formatDay(day: string): string {
  const key = dayKey(day);
  if (!key) return day;
  const [y, m, d] = key.split('-').map(Number);
  return `${d} ${MONTHS_SHORT[(m ?? 1) - 1]} ${y}`;
}

/** «Octubre de 2026». */
export function formatMonth(month: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) return month;
  return `${MONTHS_LONG[Number(m[2]) - 1]} de ${m[1]}`;
}

function bogotaParts(d: Date): Record<string, string> {
  return Object.fromEntries(
    df('parts', () =>
      Intl.DateTimeFormat('en-CA', {
        timeZone: TIME_ZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }),
    )
      .formatToParts(d)
      .map((p) => [p.type, p.value]),
  );
}

/** «2 oct 2026, 3:04 p. m.» en hora de Bogotá. */
export function formatDateTime(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  const p = bogotaParts(d);
  const h = Number(p.hour);
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${Number(p.day)} ${MONTHS_SHORT[Number(p.month) - 1]} ${p.year}, ${h12}:${p.minute} ${h < 12 ? 'a. m.' : 'p. m.'}`;
}

/** `YYYY-MM-DDTHH:mm` en hora de Bogotá, para un `<input type="datetime-local">`. */
export function toLocalInput(value: unknown): string {
  if (typeof value !== 'string') return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const p = bogotaParts(d);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

/** Un día como lo escribe una persona: `2026-10-02`, `2/10/2026`, `02-10-26`. */
export function parseDay(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  const iso = DAY_RE.exec(s);
  if (iso) return validDay(Number(iso[1]), Number(iso[2]), Number(iso[3])) ? s : null;
  const isoTime = /^(\d{4}-\d{2}-\d{2})[T ]/.exec(s);
  if (isoTime?.[1]) return dayKey(s.includes('T') ? s : isoTime[1]);
  const dmy = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(s);
  if (dmy) {
    const d = Number(dmy[1]);
    const m = Number(dmy[2]);
    let y = Number(dmy[3]);
    if (y < 100) y += 2000;
    return validDay(y, m, d) ? `${y}-${pad(m)}-${pad(d)}` : null;
  }
  return null;
}

/** Fecha y hora escrita en Bogotá → ISO con su zona. */
export function parseDateTime(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  const local = /^(\d{4}-\d{2}-\d{2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (local?.[1]) {
    const day = parseDay(local[1]);
    const h = Number(local[2]);
    const min = Number(local[3]);
    if (!day || h > 23 || min > 59) return null;
    return new Date(`${day}T${pad(h)}:${pad(min)}:${local[4] ?? '00'}-05:00`).toISOString();
  }
  const day = parseDay(s);
  if (day) return new Date(`${day}T00:00:00-05:00`).toISOString();
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

// ---------------------------------------------------------------------------
// Sin basura a la vista, duraciones, cantidades, totales
// ---------------------------------------------------------------------------

/** El guion que se muestra cuando no hay valor. */
export const DASH = '—';

/** Un texto que nunca es «undefined», «null» ni «NaN». */
export function cleanText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  const s = String(value);
  return /^(undefined|null|NaN|\[object Object\])$/i.test(s.trim()) ? '' : s;
}

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;

/**
 * Cualquier valor suelto → texto legible: números con separadores, días y
 * fechas con hora en Bogotá, vacío como «—». Para superficies que no saben el
 * tipo de lo que muestran (avisos, correos, tooltips, chat).
 */
export function formatLoose(value: unknown): string {
  if (isEmptyValue(value)) return DASH;
  if (typeof value === 'number') return Number.isFinite(value) ? formatNumber(value) : DASH;
  if (typeof value === 'boolean') return value ? 'Sí' : 'No';
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? DASH : formatDateTime(value.toISOString());
  const s = cleanText(value).trim();
  if (!s) return DASH;
  if (DAY_RE.test(s)) return formatDay(s);
  if (ISO_INSTANT.test(s)) return formatDateTime(s);
  return s;
}

/** Duración en segundos → «45 s», «3 min», «1 h 20 min», «2 d 4 h». */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return DASH;
  const sign = seconds < 0 ? '-' : '';
  const total = Math.round(Math.abs(seconds));
  if (total < 60) return `${sign}${total} s`;
  const minutes = Math.round(total / 60);
  if (minutes < 60) return `${sign}${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const restMin = minutes % 60;
  if (hours < 24) return `${sign}${hours} h${restMin ? ` ${restMin} min` : ''}`;
  const days = Math.floor(hours / 24);
  const restH = hours % 24;
  return `${sign}${days} d${restH ? ` ${restH} h` : ''}`;
}

/** Cantidad con unidad: «12 kg», «1.250 u», «2,5 m». La unidad sale tal cual. */
export function formatQuantity(n: number, unit?: string | null, maxDecimals = 3): string {
  if (!Number.isFinite(n)) return DASH;
  const text = formatNumber(n, maxDecimals);
  const u = cleanText(unit).trim();
  return u ? `${text} ${u}` : text;
}

/** Redondea a los decimales de la moneda: la suma de lo mostrado cuadra con el total mostrado. */
export function roundMoney(n: number, currency = 'COP'): number {
  const f = currency === 'COP' ? 1 : 100;
  return Math.round((n + Number.EPSILON * Math.sign(n)) * f) / f;
}

/** Suma de importes ya redondeados cada uno: el total siempre es la suma de lo que se ve. */
export function sumMoney(values: ReadonlyArray<number>, currency = 'COP'): number {
  return roundMoney(
    values.reduce((acc, v) => acc + (Number.isFinite(v) ? roundMoney(v, currency) : 0), 0),
    currency,
  );
}

/** Hora suelta «15:04» o «9:05» → «3:04 p. m.». */
export function formatClock(hhmm: string): string {
  const m = /^(\d{1,2}):(\d{2})/.exec(hhmm.trim());
  if (!m) return hhmm;
  const h = Number(m[1]);
  if (h > 23) return hhmm;
  return `${h % 12 === 0 ? 12 : h % 12}:${m[2]} ${h < 12 ? 'a. m.' : 'p. m.'}`;
}
