/**
 * PRONÓSTICO de un gráfico por fechas. Puro: recibe la serie ya agrupada
 * (una clave por día / semana / mes) y devuelve los próximos períodos.
 *
 * Reglas: el período en curso está incompleto y NO entra al ajuste; nunca
 * baja de cero; la banda es ± una desviación estándar de los residuos.
 */

export type ForecastBucket = 'day' | 'week' | 'month';
export type ForecastMethod = 'trend' | 'average' | 'seasonal';

export interface ForecastPoint {
  key: string;
  value: number;
  low: number;
  high: number;
}

export interface ForecastResult {
  points: ForecastPoint[];
  /** El método que de verdad se usó (seasonal sin historia cae a trend). */
  method: ForecastMethod;
  /** Cuántos períodos completos se usaron para ajustar. */
  basedOn: number;
}

/** Mínimo de períodos completos para proyectar algo con sentido. */
export const FORECAST_MIN_PERIODS = 3;
const TREND_WINDOW = 12;
const AVERAGE_WINDOW = 3;
const SEASONAL_MIN = 24;

const DAY_MS = 86_400_000;

function dayNumber(day: string): number {
  return Math.floor(Date.parse(`${day}T12:00:00Z`) / DAY_MS);
}

function dayFromNumber(n: number): string {
  return new Date(n * DAY_MS + DAY_MS / 2).toISOString().slice(0, 10);
}

/** Posición entera de una clave de período (para contar huecos). */
export function periodIndex(key: string, bucket: ForecastBucket): number {
  if (bucket === 'month') {
    const [y = 1970, m = 1] = key.split('-').map(Number);
    return y * 12 + (m - 1);
  }
  const d = dayNumber(key);
  return bucket === 'week' ? Math.floor(d / 7) : d;
}

/** La clave del período que está `n` después de `key`. */
export function shiftKey(key: string, bucket: ForecastBucket, n: number): string {
  if (bucket === 'month') {
    const idx = periodIndex(key, 'month') + n;
    const y = Math.floor(idx / 12);
    return `${String(y).padStart(4, '0')}-${String((idx % 12) + 1).padStart(2, '0')}`;
  }
  return dayFromNumber(dayNumber(key) + (bucket === 'week' ? 7 * n : n));
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
}

function std(residuals: number[], dof: number): number {
  if (residuals.length <= dof) return 0;
  return Math.sqrt(residuals.reduce((a, r) => a + r * r, 0) / (residuals.length - dof));
}

function fitLine(xs: number[], ys: number[]): { slope: number; intercept: number } {
  const mx = mean(xs);
  const my = mean(ys);
  let num = 0;
  let den = 0;
  for (let i = 0; i < xs.length; i++) {
    num += ((xs[i] ?? 0) - mx) * ((ys[i] ?? 0) - my);
    den += ((xs[i] ?? 0) - mx) ** 2;
  }
  const slope = den === 0 ? 0 : num / den;
  return { slope, intercept: my - slope * mx };
}

const round = (n: number) => Math.round(n * 100) / 100;

/**
 * @param series  períodos con dato, de cualquier orden: `{ key, value }`.
 * @param currentKey  la clave del período en curso (hoy); sale del ajuste.
 * @param fillGaps  los períodos sin filas cuentan como cero (conteo y suma).
 * @returns null si no hay al menos 3 períodos completos.
 */
export function forecastSeries(opts: {
  series: Array<{ key: string; value: number }>;
  bucket: ForecastBucket;
  periods: number;
  method: ForecastMethod;
  currentKey: string;
  fillGaps?: boolean;
}): ForecastResult | null {
  const { bucket, periods, currentKey } = opts;
  const sorted = [...opts.series].sort((a, b) => a.key.localeCompare(b.key));
  const lastKey = sorted[sorted.length - 1]?.key;
  if (!lastKey) return null;
  const full = sorted.filter((p) => p.key < currentKey);
  if (full.length < FORECAST_MIN_PERIODS) return null;

  // Posiciones contiguas; los huecos valen cero o se saltan.
  const byIdx = new Map(full.map((p) => [periodIndex(p.key, bucket), p.value]));
  const firstIdx = periodIndex(full[0]?.key ?? currentKey, bucket);
  const lastFullIdx = periodIndex(full[full.length - 1]?.key ?? currentKey, bucket);
  const dense: Array<{ x: number; y: number }> = [];
  for (let i = firstIdx; i <= lastFullIdx; i++) {
    const v = byIdx.get(i);
    if (v !== undefined) dense.push({ x: i, y: v });
    else if (opts.fillGaps) dense.push({ x: i, y: 0 });
  }
  if (dense.length < FORECAST_MIN_PERIODS) return null;

  const startIdx = periodIndex(lastKey, bucket) + 1;
  const season = bucket === 'month' ? 12 : bucket === 'week' ? 52 : 7;
  let method = opts.method;
  if (method === 'seasonal' && (dense.length < SEASONAL_MIN || dense.length < 2 * season))
    method = 'trend';

  const out: ForecastPoint[] = [];
  const push = (step: number, value: number, sd: number) => {
    const v = Math.max(0, value);
    out.push({
      key: shiftKey(lastKey, bucket, step),
      value: round(v),
      low: round(Math.max(0, v - sd)),
      high: round(v + sd),
    });
  };

  if (method === 'average') {
    const last = dense.slice(-AVERAGE_WINDOW).map((d) => d.y);
    const m = mean(last);
    const sd = std(
      last.map((y) => y - m),
      1,
    );
    for (let s = 1; s <= periods; s++) push(s, m, sd);
    return { points: out, method, basedOn: last.length };
  }

  if (method === 'seasonal') {
    const win = dense.slice(-3 * season);
    const { slope, intercept } = fitLine(
      win.map((d) => d.x),
      win.map((d) => d.y),
    );
    const phase = (x: number) => ((x % season) + season) % season;
    const sums = new Map<number, number[]>();
    for (const d of win) {
      const arr = sums.get(phase(d.x)) ?? [];
      arr.push(d.y - (intercept + slope * d.x));
      sums.set(phase(d.x), arr);
    }
    const factor = (x: number) => mean(sums.get(phase(x)) ?? [0]);
    const residuals = win.map((d) => d.y - (intercept + slope * d.x + factor(d.x)));
    const sd = std(residuals, 2);
    for (let s = 1; s <= periods; s++) {
      const x = startIdx + s - 1;
      push(s, intercept + slope * x + factor(x), sd);
    }
    return { points: out, method, basedOn: win.length };
  }

  const win = dense.slice(-TREND_WINDOW);
  const { slope, intercept } = fitLine(
    win.map((d) => d.x),
    win.map((d) => d.y),
  );
  const sd = std(
    win.map((d) => d.y - (intercept + slope * d.x)),
    2,
  );
  for (let s = 1; s <= periods; s++) push(s, intercept + slope * (startIdx + s - 1), sd);
  return { points: out, method: 'trend', basedOn: win.length };
}

/** «tendencia de los últimos 12 meses» para el pie del gráfico. */
export function forecastBasis(method: ForecastMethod, bucket: ForecastBucket, n: number): string {
  const unit =
    bucket === 'month'
      ? n === 1 ? 'mes' : 'meses'
      : bucket === 'week'
        ? n === 1 ? 'semana' : 'semanas'
        : n === 1 ? 'día' : 'días';
  const what = method === 'average' ? 'promedio' : method === 'seasonal' ? 'tendencia y temporada' : 'tendencia';
  const last = bucket === 'week' ? (n === 1 ? 'la última' : 'las últimas') : n === 1 ? 'el último' : 'los últimos';
  return `${what} de ${last} ${n === 1 ? '' : `${n} `}${unit}`;
}
