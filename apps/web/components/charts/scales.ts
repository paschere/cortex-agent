/**
 * Matemática pura del kit de gráficos: marcas «redondas», cifras compactas en
 * español de Colombia, curvas monótonas y barras redondeadas. Sin React ni DOM,
 * para poder probarla con cifras y para que nada de aquí tumbe un build.
 */

// ---------------------------------------------------------------------------
// Marcas del eje
// ---------------------------------------------------------------------------

/** Marcas «redondas» (0, 50, 100…) que cubren [lo, hi]. Siempre devuelve ≥ 2. */
export function niceTicks(loIn: number, hiIn: number, count = 4): number[] {
  if (!Number.isFinite(loIn) || !Number.isFinite(hiIn)) return [0, 1];
  let lo = Math.min(loIn, hiIn);
  let hi = Math.max(loIn, hiIn);
  if (hi === lo) {
    if (hi === 0) return [0, 1];
    const wide = hi > 0 ? [0, hi * 1.1] : [hi * 1.1, 0];
    lo = wide[0] as number;
    hi = wide[1] as number;
  }
  const raw = (hi - lo) / Math.max(1, count);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = ([1, 2, 2.5, 5, 10].find((m) => m * mag >= raw - 1e-12) ?? 10) * mag;
  const start = Math.floor(lo / step + 1e-9) * step;
  const ticks: number[] = [];
  for (let i = 0; i < 40; i++) {
    const v = Number((start + i * step).toFixed(10));
    ticks.push(v === 0 ? 0 : v);
    if (v >= hi - step * 1e-9) break;
  }
  return ticks;
}

export interface Domain {
  min: number;
  max: number;
  ticks: number[];
}

/** El eje que cubre todos los valores (y el cero, si se pide). */
export function niceDomain(
  values: readonly number[],
  opts: { includeZero?: boolean; count?: number } = {},
): Domain {
  const finite = values.filter((v) => Number.isFinite(v));
  let lo = finite.length ? Math.min(...finite) : 0;
  let hi = finite.length ? Math.max(...finite) : 0;
  if (opts.includeZero ?? true) {
    lo = Math.min(lo, 0);
    hi = Math.max(hi, 0);
  }
  const ticks = niceTicks(lo, hi, opts.count ?? 4);
  return { min: ticks[0] ?? 0, max: ticks[ticks.length - 1] ?? 1, ticks };
}

/** Posición lineal de `v` de [d0,d1] a [r0,r1]. */
export function linear(d0: number, d1: number, r0: number, r1: number): (v: number) => number {
  const span = d1 - d0 || 1;
  return (v) => r0 + ((v - d0) / span) * (r1 - r0);
}

/** Qué etiquetas del eje x se muestran: espaciadas parejo, sin chocar. */
export function labelIndexes(n: number, maxLabels: number): number[] {
  if (n <= 0) return [];
  const cap = Math.max(1, Math.floor(maxLabels));
  if (n <= cap) return Array.from({ length: n }, (_, i) => i);
  const every = Math.ceil(n / cap);
  const out: number[] = [];
  for (let i = 0; i < n; i += every) out.push(i);
  // La última sólo si cabe sin pisar a la anterior.
  const last = out[out.length - 1] ?? 0;
  if (n - 1 !== last && n - 1 - last >= every) out.push(n - 1);
  return out;
}

// ---------------------------------------------------------------------------
// Cifras en español (es-CO)
// ---------------------------------------------------------------------------

const GROUPED = new Intl.NumberFormat('es-CO', {
  maximumFractionDigits: 0,
  useGrouping: 'always' as unknown as boolean,
});
const ONE_DECIMAL = new Intl.NumberFormat('es-CO', {
  maximumFractionDigits: 1,
  useGrouping: 'always' as unknown as boolean,
});

/** «1.240», «−3.500». */
export function formatFull(n: number): string {
  if (!Number.isFinite(n)) return '—';
  return (n < 0 ? '−' : '') + GROUPED.format(Math.abs(Math.round(n)));
}

/** [divisor, sufijo, desde cuánto se usa]. «mil» desde 10.000: 1.240 se escribe entero. */
const UNITS: Array<[number, string, number]> = [
  [1e12, ' B', 1e12],
  [1e9, ' mil M', 1e9],
  [1e6, ' M', 1e6],
  [1e3, ' mil', 1e4],
];

/**
 * Cifras cortas para el eje: «1.240», «48 mil», «48,2 M», «1,2 mil M».
 * Con `money`, «$ 48,2 M»; con `percent`, «12 %».
 */
export function formatCompact(
  n: number,
  opts: { money?: boolean; percent?: boolean; prefix?: string; suffix?: string } = {},
): string {
  if (!Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  let body: string;
  const unit = UNITS.find(([, , from]) => abs >= from);
  if (unit) {
    const scaled = abs / unit[0];
    body = (scaled >= 100 ? GROUPED : ONE_DECIMAL).format(scaled) + unit[1];
  } else if (abs < 100) {
    body = ONE_DECIMAL.format(abs);
  } else {
    body = GROUPED.format(Math.round(abs));
  }
  const sign = n < 0 && body.replace(/[^1-9]/g, '') !== '' ? '−' : '';
  const prefix = opts.prefix ?? (opts.money ? '$ ' : '');
  const suffix = opts.suffix ?? (opts.percent ? ' %' : '');
  return `${sign}${prefix}${body}${suffix}`;
}

/** Un formateador de eje según cómo se escriben los valores («$ 1.200», «12 %»). */
export function axisFormatterFor(sample: string | undefined): (n: number) => string {
  const s = sample?.trim() ?? '';
  const money = s.startsWith('$') || s.startsWith('−$') || s.startsWith('-$');
  const percent = s.endsWith('%');
  return (n) => formatCompact(n, { money, percent });
}

/** Cambio relativo de `cur` frente a `prev`; `null` si no hay base. */
export function deltaRatio(cur: number, prev: number): number | null {
  if (!Number.isFinite(cur) || !Number.isFinite(prev) || prev === 0) return null;
  return (cur - prev) / Math.abs(prev);
}

/** «+12 %», «−8 %», «= 0 %». */
export function formatDelta(ratio: number | null): string {
  if (ratio === null) return 'nuevo';
  const pct = Math.round(ratio * 100);
  if (pct === 0) return '= 0 %';
  return `${pct > 0 ? '+' : '−'}${GROUPED.format(Math.abs(pct))} %`;
}

// ---------------------------------------------------------------------------
// Curvas
// ---------------------------------------------------------------------------

export interface Pt {
  x: number;
  y: number;
}

const f = (n: number) => (Math.round(n * 100) / 100).toString();

/**
 * Cúbica monótona (Fritsch–Carlson): suave, y nunca se pasa de los datos — una
 * serie que sólo sube no hace una joroba que baja. Con 1 punto, un `M`; con 2,
 * una recta.
 */
export function monotonePath(pts: readonly Pt[]): string {
  const n = pts.length;
  if (n === 0) return '';
  const p0 = pts[0] as Pt;
  if (n === 1) return `M${f(p0.x)},${f(p0.y)}`;
  if (n === 2) {
    const p1 = pts[1] as Pt;
    return `M${f(p0.x)},${f(p0.y)}L${f(p1.x)},${f(p1.y)}`;
  }
  const dx: number[] = [];
  const slope: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const a = pts[i] as Pt;
    const b = pts[i + 1] as Pt;
    const d = b.x - a.x || 1e-9;
    dx.push(d);
    slope.push((b.y - a.y) / d);
  }
  const m: number[] = new Array(n);
  m[0] = slope[0] as number;
  m[n - 1] = slope[n - 2] as number;
  for (let i = 1; i < n - 1; i++) {
    const s0 = slope[i - 1] as number;
    const s1 = slope[i] as number;
    m[i] = s0 * s1 <= 0 ? 0 : (s0 + s1) / 2;
  }
  for (let i = 0; i < n - 1; i++) {
    const s = slope[i] as number;
    if (s === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = (m[i] as number) / s;
    const b = (m[i + 1] as number) / s;
    const h = a * a + b * b;
    if (h > 9) {
      const t = 3 / Math.sqrt(h);
      m[i] = t * a * s;
      m[i + 1] = t * b * s;
    }
  }
  let d = `M${f(p0.x)},${f(p0.y)}`;
  for (let i = 0; i < n - 1; i++) {
    const a = pts[i] as Pt;
    const b = pts[i + 1] as Pt;
    const w = (dx[i] as number) / 3;
    d += `C${f(a.x + w)},${f(a.y + w * (m[i] as number))} ${f(b.x - w)},${f(b.y - w * (m[i + 1] as number))} ${f(b.x)},${f(b.y)}`;
  }
  return d;
}

/** Relleno bajo la curva hasta la línea `baseY`. */
export function areaPath(pts: readonly Pt[], baseY: number): string {
  if (pts.length < 2) return '';
  const first = pts[0] as Pt;
  const last = pts[pts.length - 1] as Pt;
  return `${monotonePath(pts)}L${f(last.x)},${f(baseY)}L${f(first.x)},${f(baseY)}Z`;
}

/** Banda entre dos curvas (para el «rango probable»): `hi` de ida, `lo` de vuelta. */
export function bandPath(hi: readonly Pt[], lo: readonly Pt[]): string {
  if (hi.length < 2 || lo.length < 2) return '';
  const back = monotonePath([...lo].reverse());
  return `${monotonePath(hi)}L${back.slice(1)}Z`;
}

// ---------------------------------------------------------------------------
// Barras
// ---------------------------------------------------------------------------

/**
 * Una barra de `yBase` a `yEnd` con las esquinas del extremo redondeadas
 * (`rOuter`) y las del lado del cero apenas (`rInner`). Sirve hacia arriba y
 * hacia abajo. Devuelve '' si la barra no se ve.
 */
export function roundedBar(
  x: number,
  yBase: number,
  yEnd: number,
  w: number,
  rOuter = 4,
  rInner = 1.5,
): string {
  const h = Math.abs(yEnd - yBase);
  if (h < 0.4 || w <= 0) return '';
  const ro = Math.min(rOuter, w / 2, h);
  const ri = Math.min(rInner, w / 2, Math.max(h - ro, 0));
  const r = x + w;
  if (yEnd < yBase) {
    // Hacia arriba: el extremo es la parte de arriba.
    return `M${f(x)},${f(yBase - ri)}Q${f(x)},${f(yBase)} ${f(x + ri)},${f(yBase)}H${f(r - ri)}Q${f(r)},${f(yBase)} ${f(r)},${f(yBase - ri)}V${f(yEnd + ro)}Q${f(r)},${f(yEnd)} ${f(r - ro)},${f(yEnd)}H${f(x + ro)}Q${f(x)},${f(yEnd)} ${f(x)},${f(yEnd + ro)}Z`;
  }
  return `M${f(x)},${f(yBase + ri)}Q${f(x)},${f(yBase)} ${f(x + ri)},${f(yBase)}H${f(r - ri)}Q${f(r)},${f(yBase)} ${f(r)},${f(yBase + ri)}V${f(yEnd - ro)}Q${f(r)},${f(yEnd)} ${f(r - ro)},${f(yEnd)}H${f(x + ro)}Q${f(x)},${f(yEnd)} ${f(x)},${f(yEnd - ro)}Z`;
}

export interface Segment {
  key: string;
  value: number;
  /** Posición inicial y ancho como fracción de 0..1 del total. */
  start: number;
  size: number;
  share: number;
}

/** Reparte un total en tramos (para la barra segmentada). Ignora lo ≤ 0. */
export function segmentShares(items: ReadonlyArray<{ key: string; value: number }>): Segment[] {
  const live = items.filter((i) => i.value > 0);
  const total = live.reduce((a, i) => a + i.value, 0);
  if (total <= 0) return [];
  let cursor = 0;
  return live.map((i) => {
    const size = i.value / total;
    const seg = { key: i.key, value: i.value, start: cursor, size, share: size };
    cursor += size;
    return seg;
  });
}

// ---------------------------------------------------------------------------
// Estado y descripción
// ---------------------------------------------------------------------------

export type DataState = 'empty' | 'zero' | 'single' | 'ok';

/** ¿Hay con qué dibujar? Vacío, todo en cero, un solo punto, o bien. */
export function dataState(series: ReadonlyArray<ReadonlyArray<number | null>>): DataState {
  const all = series.flat().filter((v): v is number => v !== null && Number.isFinite(v));
  if (all.length === 0) return 'empty';
  if (all.every((v) => v === 0)) return 'zero';
  const longest = Math.max(...series.map((s) => s.filter((v) => v !== null).length));
  return longest < 2 ? 'single' : 'ok';
}

/** Una frase con la tendencia, para el lector de pantalla. */
export function describeTrend(args: {
  name: string;
  labels: readonly string[];
  values: ReadonlyArray<number | null>;
  format: (n: number) => string;
}): string {
  const { name, labels, values, format } = args;
  const idx = values.map((v, i) => (v === null ? -1 : i)).filter((i) => i >= 0);
  if (idx.length === 0) return `${name}: sin datos.`;
  const firstI = idx[0] as number;
  const lastI = idx[idx.length - 1] as number;
  const first = values[firstI] as number;
  const last = values[lastI] as number;
  if (idx.length === 1) return `${name}: ${format(last)} (${labels[lastI] ?? ''}).`;
  const ratio = deltaRatio(last, first);
  const dir = last > first ? 'sube' : last < first ? 'baja' : 'se mantiene';
  const change =
    ratio === null || last === first
      ? ''
      : ` ${formatDelta(ratio).replace('−', 'menos ').replace('+', '')}`;
  let hiI = firstI;
  let loI = firstI;
  for (const i of idx) {
    if ((values[i] as number) > (values[hiI] as number)) hiI = i;
    if ((values[i] as number) < (values[loI] as number)) loI = i;
  }
  const range =
    hiI !== loI
      ? ` Máximo ${format(values[hiI] as number)} (${labels[hiI] ?? ''}), mínimo ${format(values[loI] as number)} (${labels[loI] ?? ''}).`
      : '';
  return `${name}: de ${format(first)} (${labels[firstI] ?? ''}) a ${format(last)} (${labels[lastI] ?? ''}); ${dir}${change}.${range}`;
}

const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

/** «2026-09-30» → «30 sep». Lo que no es una fecha ISO vuelve tal cual. */
export function shortDay(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1] ?? ''}`;
}

/** Tono de un gráfico a partir de una clase de Tailwind (`bg-rose`, `text-amber`…). */
export function toneOfClass(cls: string): 'primary' | 'emerald' | 'amber' | 'sky' | 'rose' | 'ink' {
  const hit = /(?:bg|text|fill)-(primary|emerald|amber|sky|rose)/.exec(cls);
  return (hit?.[1] as 'primary' | 'emerald' | 'amber' | 'sky' | 'rose' | undefined) ?? 'ink';
}
