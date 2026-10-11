/**
 * LA LÓGICA PURA DE LOS GRÁFICOS INTERACTIVOS: rangos, cubetas, comparación,
 * pincel, zoom, exportación y qué registros hay detrás de un punto.
 *
 * Sin React ni DOM: se prueba aparte (interactive.test.ts) y la usa el
 * `MetricChart` del navegador. Las fechas son `AAAA-MM-DD` (día de Bogotá) y
 * se calculan en UTC para que ningún huso corra un día.
 */

export type RangeId = '7d' | '30d' | '90d' | '12m';
export type Granularity = 'day' | 'week' | 'month';

export interface RangeDef {
  id: RangeId;
  /** Lo que dice el botón. */
  label: string;
  /** «los últimos 30 días», para frases. */
  phrase: string;
  /** Días hacia atrás desde hoy (el primero y hoy cuentan). */
  days: number;
  granularity: Granularity;
  /** Cubetas hacia el futuro para la proyección. */
  horizon: number;
}

export const RANGES: readonly RangeDef[] = [
  { id: '7d', label: '7 d', phrase: 'los últimos 7 días', days: 7, granularity: 'day', horizon: 7 },
  {
    id: '30d',
    label: '30 d',
    phrase: 'los últimos 30 días',
    days: 30,
    granularity: 'day',
    horizon: 14,
  },
  {
    id: '90d',
    label: '90 d',
    phrase: 'los últimos 90 días',
    days: 91,
    granularity: 'week',
    horizon: 4,
  },
  {
    id: '12m',
    label: '12 m',
    phrase: 'los últimos 12 meses',
    days: 365,
    granularity: 'month',
    horizon: 3,
  },
];

export function rangeById(id: RangeId): RangeDef {
  return RANGES.find((r) => r.id === id) ?? (RANGES[1] as RangeDef);
}

// ---------------------------------------------------------------------------
// Fechas
// ---------------------------------------------------------------------------

const MS = 86_400_000;

function toUtc(iso: string): number {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return Date.UTC(y as number, (m as number) - 1, d as number);
}
function fromUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
export function addDaysIso(iso: string, n: number): string {
  return fromUtc(toUtc(iso) + n * MS);
}
export function diffDays(a: string, b: string): number {
  return Math.round((toUtc(a) - toUtc(b)) / MS);
}
export function addMonthsIso(iso: string, n: number): string {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  const total = (y as number) * 12 + ((m as number) - 1) + n;
  const ny = Math.floor(total / 12);
  const nm = total % 12;
  const last = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  return fromUtc(Date.UTC(ny, nm, Math.min(d as number, last)));
}
function monthStart(iso: string): string {
  return `${iso.slice(0, 7)}-01`;
}

const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const MONTHS_LONG = [
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

/** «12 oct». */
export function dayLabel(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1] ?? ''}` : iso;
}
/** «oct» o «oct 25» si cambia el año. */
function monthLabel(iso: string, withYear: boolean): string {
  const m = Number(iso.slice(5, 7)) - 1;
  return withYear ? `${MONTHS[m]} ${iso.slice(2, 4)}` : (MONTHS[m] ?? '');
}

// ---------------------------------------------------------------------------
// Ventana y cubetas
// ---------------------------------------------------------------------------

export interface DayPoint {
  date: string;
  value: number;
}

export interface Bucket {
  /** Primer día de la cubeta. */
  start: string;
  /** Último día (incluido). */
  end: string;
  label: string;
  /** Para la ficha: «12 oct», «6 – 12 oct», «octubre 2026». */
  title: string;
  value: number | null;
  /** La cubeta es del futuro (después de hoy). */
  future: boolean;
  /** Contiene el día de hoy. */
  isNow: boolean;
}

export interface Window {
  from: string;
  /** Último día de la historia (hoy). */
  to: string;
}

/** Los días de la ventana `offset` períodos atrás (0 = la actual, 1 = la anterior). */
export function rangeWindow(today: string, range: RangeDef, offset = 0): Window {
  if (range.granularity === 'month') {
    const endMonth = addMonthsIso(monthStart(today), -12 * offset);
    const from = addMonthsIso(endMonth, -11);
    const to = offset === 0 ? today : addDaysIso(addMonthsIso(endMonth, 1), -1);
    return { from, to };
  }
  const to = addDaysIso(today, -range.days * offset);
  return { from: addDaysIso(to, -(range.days - 1)), to };
}

function buildEdges(win: Window, range: RangeDef, horizon: number): Array<[string, string]> {
  const edges: Array<[string, string]> = [];
  if (range.granularity === 'day') {
    const total = diffDays(win.to, win.from) + 1 + horizon;
    for (let i = 0; i < total; i++) {
      const d = addDaysIso(win.from, i);
      edges.push([d, d]);
    }
  } else if (range.granularity === 'week') {
    const weeks = Math.ceil((diffDays(win.to, win.from) + 1) / 7) + horizon;
    for (let i = 0; i < weeks; i++) {
      const s = addDaysIso(win.from, i * 7);
      edges.push([s, addDaysIso(s, 6)]);
    }
  } else {
    const months = 12 + horizon;
    for (let i = 0; i < months; i++) {
      const s = addMonthsIso(win.from, i);
      edges.push([s, addDaysIso(addMonthsIso(s, 1), -1)]);
    }
  }
  return edges;
}

export interface BucketizeOptions {
  /** `last`: saldo al cierre de la cubeta (caja). `sum`: lo que pasó adentro (ventas). */
  mode: 'last' | 'sum';
  /** Cubetas después de hoy. 0 para la comparación. */
  horizon?: number;
  /** Con `sum`, hoy mismo: los días de después de hoy son del futuro. */
  today?: string;
}

/**
 * Parte una serie diaria en las cubetas de un rango. `last` arrastra el último
 * valor conocido (una caja no desaparece un día sin movimientos); `sum` suma lo
 * de adentro y deja `null` donde la serie todavía no existía.
 */
export function bucketize(
  points: readonly DayPoint[],
  win: Window,
  range: RangeDef,
  opts: BucketizeOptions,
): Bucket[] {
  const horizon = opts.horizon ?? 0;
  const today = opts.today ?? win.to;
  const sorted = [...points].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const firstDate = sorted[0]?.date ?? null;
  const edges = buildEdges(win, range, horizon);
  const withYear = edges.length > 0 && edges[0]?.[0].slice(0, 4) !== edges.at(-1)?.[0].slice(0, 4);
  let cursor = 0;
  let carried: number | null = null;
  // `last` necesita el último valor ANTES de la ventana.
  while (cursor < sorted.length && (sorted[cursor] as DayPoint).date < win.from) {
    carried = (sorted[cursor] as DayPoint).value;
    cursor++;
  }
  return edges.map(([start, end]) => {
    let sum = 0;
    let seen = false;
    while (cursor < sorted.length && (sorted[cursor] as DayPoint).date <= end) {
      const p = sorted[cursor] as DayPoint;
      carried = p.value;
      sum += p.value;
      seen = true;
      cursor++;
    }
    let value: number | null;
    if (opts.mode === 'last') value = carried;
    else value = seen || (firstDate !== null && firstDate <= start) ? sum : null;
    const future = start > today;
    const isNow = start <= today && end >= today;
    const g = range.granularity;
    const label =
      g === 'month'
        ? monthLabel(start, withYear)
        : g === 'week'
          ? dayLabel(start)
          : dayLabel(start);
    const title =
      g === 'month'
        ? `${MONTHS_LONG[Number(start.slice(5, 7)) - 1]} ${start.slice(0, 4)}`
        : g === 'week'
          ? `${dayLabel(start)} – ${dayLabel(end)}`
          : dayLabel(start);
    return { start, end, label, title, value, future, isNow };
  });
}

/** Índice de la cubeta que contiene `date`, o -1. */
export function bucketIndexOf(buckets: readonly Bucket[], date: string): number {
  return buckets.findIndex((b) => date >= b.start && date <= b.end);
}

// ---------------------------------------------------------------------------
// Proyección
// ---------------------------------------------------------------------------

export interface ProjectionPoint {
  date: string;
  value: number;
  lo: number;
  hi: number;
}

/**
 * Alinea una proyección diaria a las cubetas FUTURAS del rango: toma el último
 * valor de cada cubeta. Devuelve un arreglo del largo de `buckets`, con `null`
 * donde no hay proyección (pasado), y el punto de empalme (hoy) como ancla.
 */
export function alignProjection(
  buckets: readonly Bucket[],
  projection: readonly ProjectionPoint[],
  anchor: { index: number; value: number },
): { values: Array<number | null>; lo: number[]; hi: number[]; from: number } {
  const values: Array<number | null> = buckets.map(() => null);
  const lo: number[] = buckets.map(() => 0);
  const hi: number[] = buckets.map(() => 0);
  const sorted = [...projection].sort((a, b) => (a.date < b.date ? -1 : 1));
  let cursor = 0;
  let last: ProjectionPoint | null = null;
  buckets.forEach((b, i) => {
    while (cursor < sorted.length && (sorted[cursor] as ProjectionPoint).date <= b.end) {
      last = sorted[cursor] as ProjectionPoint;
      cursor++;
    }
    if (i < anchor.index) return;
    if (i === anchor.index) {
      values[i] = anchor.value;
      lo[i] = anchor.value;
      hi[i] = anchor.value;
      return;
    }
    const l = last as ProjectionPoint | null;
    if (l) {
      values[i] = l.value;
      lo[i] = l.lo;
      hi[i] = l.hi;
    }
  });
  return { values, lo, hi, from: anchor.index };
}

// ---------------------------------------------------------------------------
// Comparación y resumen del período
// ---------------------------------------------------------------------------

/** Los valores de la ventana anterior, alineados por posición con la actual. */
export function comparisonValues(
  points: readonly DayPoint[],
  today: string,
  range: RangeDef,
  mode: 'last' | 'sum',
  length: number,
): Array<number | null> {
  const prev = rangeWindow(today, range, 1);
  const b = bucketize(points, prev, range, { mode, today: prev.to });
  return Array.from({ length }, (_, i) => b[i]?.value ?? null);
}

export interface PeriodSummary {
  /** Lo que se muestra de titular: el saldo de hoy o la suma del período. */
  current: number | null;
  /** Contra qué se compara: el saldo al inicio, o la suma del período anterior. */
  previous: number | null;
  ratio: number | null;
}

export function periodSummary(
  history: readonly Bucket[],
  comparison: ReadonlyArray<number | null>,
  mode: 'last' | 'sum',
): PeriodSummary {
  const hist = history.filter((b) => !b.future);
  if (hist.length === 0) return { current: null, previous: null, ratio: null };
  let current: number | null;
  let previous: number | null;
  if (mode === 'last') {
    current = hist.at(-1)?.value ?? null;
    previous = hist[0]?.value ?? null;
  } else {
    const vals = hist.map((b) => b.value);
    current = vals.every((v) => v === null) ? null : vals.reduce<number>((s, v) => s + (v ?? 0), 0);
    const prev = comparison.slice(0, hist.length);
    previous = prev.every((v) => v === null)
      ? null
      : prev.reduce<number>((s, v) => s + (v ?? 0), 0);
  }
  if (current === null || previous === null || Math.abs(previous) < 0.5)
    return { current, previous, ratio: null };
  return { current, previous, ratio: (current - previous) / Math.abs(previous) };
}

// ---------------------------------------------------------------------------
// Pincel y zoom
// ---------------------------------------------------------------------------

/** El índice del eje x bajo un pixel del área de trazado (misma cuenta que el gráfico). */
export function indexFromPx(
  px: number,
  geo: { n: number; plotW: number; hasBars: boolean },
): number {
  const { n, plotW, hasBars } = geo;
  if (n <= 1) return 0;
  const band = plotW / n;
  const inset = hasBars ? band / 2 : Math.min(10, plotW / 12);
  const step = hasBars ? band : (plotW - inset * 2) / (n - 1);
  const i = hasBars ? Math.floor(px / band) : Math.round((px - inset) / step);
  return Math.min(n - 1, Math.max(0, i));
}

/** Dos pixeles arrastrados → un par de índices ordenados (o null si fue un clic). */
export function brushIndexes(
  px0: number,
  px1: number,
  geo: { n: number; plotW: number; hasBars: boolean },
  minSpan = 1,
): [number, number] | null {
  const a = indexFromPx(px0, geo);
  const b = indexFromPx(px1, geo);
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  return hi - lo >= minSpan ? [lo, hi] : null;
}

export type Zoom = [number, number];

/** Un rango visible [a, b] (incluidos) dentro de `n` posiciones. */
export function clampZoom(z: Zoom, n: number): Zoom {
  const a = Math.max(0, Math.min(z[0], n - 1));
  const b = Math.max(a, Math.min(z[1], n - 1));
  return [a, b];
}

/** El pincel se dio sobre lo visible: a índices del total. */
export function brushToZoom(visible: Zoom, brush: [number, number]): Zoom {
  return [visible[0] + brush[0], visible[0] + brush[1]];
}

/**
 * Acerca (`factor < 1`) o aleja (`factor > 1`) alrededor de un punto. Nunca
 * deja menos de `minSpan + 1` posiciones ni se sale de [0, n-1].
 */
export function zoomAround(
  visible: Zoom,
  n: number,
  factor: number,
  center?: number,
  minSpan = 3,
): Zoom {
  const [a, b] = clampZoom(visible, n);
  const len = b - a + 1;
  const target = Math.min(n, Math.max(minSpan + 1, Math.round(len * factor)));
  if (target >= n) return [0, n - 1];
  const c = center === undefined ? (a + b) / 2 : center;
  const rel = len > 1 ? (c - a) / (len - 1) : 0.5;
  let start = Math.round(c - rel * (target - 1));
  start = Math.max(0, Math.min(start, n - target));
  return [start, start + target - 1];
}

export function isZoomed(z: Zoom | null, n: number): boolean {
  return z !== null && (z[0] > 0 || z[1] < n - 1);
}

export function sliceZoom<T>(arr: readonly T[], z: Zoom | null): T[] {
  return z ? arr.slice(z[0], z[1] + 1) : [...arr];
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

function csvCell(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return '';
  const s =
    typeof v === 'number' ? (Number.isFinite(v) ? String(Math.round(v * 100) / 100) : '') : v;
  // Una celda que empieza con = + - @ se leería como fórmula en una hoja de cálculo.
  const safe = typeof v === 'string' && /^[=+\-@]/.test(s) ? `'${s}` : s;
  return /[",\n\r;]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function toCsv(
  header: readonly string[],
  rows: ReadonlyArray<ReadonlyArray<string | number | null | undefined>>,
): string {
  return [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n');
}

export function seriesCsv(
  labels: readonly string[],
  series: ReadonlyArray<{ label: string; values: ReadonlyArray<number | null | undefined> }>,
  firstColumn = 'Fecha',
): string {
  return toCsv(
    [firstColumn, ...series.map((s) => s.label)],
    labels.map((l, i) => [l, ...series.map((s) => s.values[i] ?? null)]),
  );
}

// ---------------------------------------------------------------------------
// Lo que hay detrás de un punto
// ---------------------------------------------------------------------------

export interface DrillRecord {
  id: string;
  /** El día del registro (liquidado, vence o se emitió, según la métrica). */
  date: string;
  /** Hasta cuándo sigue «activo» (para saldos como lo vencido); sin valor = sigue. */
  until?: string | null;
  title: string;
  subtitle?: string | null;
  /** Con signo: positivo entra, negativo sale. */
  amount: number;
  tone?: 'emerald' | 'rose' | 'amber' | 'primary' | 'ink';
  href?: string | null;
}

/** Los registros de una cubeta: por fecha (flujos) o activos al cierre (saldos). */
export function recordsForBucket(
  records: readonly DrillRecord[],
  bucket: Pick<Bucket, 'start' | 'end'>,
  kind: 'flow' | 'stock',
  limit = 200,
): { rows: DrillRecord[]; total: number; sum: number } {
  const hit =
    kind === 'flow'
      ? records.filter((r) => r.date >= bucket.start && r.date <= bucket.end)
      : records.filter((r) => r.date <= bucket.end && (!r.until || r.until > bucket.end));
  hit.sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
  return {
    rows: hit.slice(0, limit),
    total: hit.length,
    sum: hit.reduce((s, r) => s + r.amount, 0),
  };
}

// ---------------------------------------------------------------------------
// La pregunta para Cortex
// ---------------------------------------------------------------------------

export function askPrompt(args: {
  metric: string;
  rangePhrase: string;
  from: string;
  to: string;
  headline?: string | null;
  focus?: string | null;
}): string {
  const base = `Explícame la gráfica «${args.metric}» de ${args.rangePhrase} (del ${dayLabel(args.from)} al ${dayLabel(args.to)})${
    args.headline ? `. Hoy marca ${args.headline}` : ''
  }.`;
  const focus = args.focus ? ` Me interesa en particular ${args.focus}.` : '';
  return `${base}${focus} ¿Qué cambió, por qué, y qué debería hacer?`;
}

export function askHref(prompt: string): string {
  return `/chat?prompt=${encodeURIComponent(prompt)}`;
}
