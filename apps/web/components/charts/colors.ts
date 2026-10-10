/**
 * Colores del kit: siempre variables del tema (`rgb(var(--x))`), nunca un
 * hexadecimal, para que el mismo gráfico se vea bien en claro y en oscuro.
 * `primary` toma `--view-fill` si la vista trae marca (ver views.css).
 */
export type ChartTone = 'primary' | 'emerald' | 'amber' | 'sky' | 'rose' | 'ink';

export const CHART_COLOR: Record<ChartTone, string> = {
  primary: 'rgb(var(--view-fill, var(--primary)))',
  emerald: 'rgb(var(--emerald))',
  amber: 'rgb(var(--amber))',
  sky: 'rgb(var(--sky))',
  rose: 'rgb(var(--rose))',
  ink: 'rgb(var(--ink-faint))',
};

/** Variante suave (fondos de ficha) de cada tono. */
export const CHART_SOFT: Record<ChartTone, string> = {
  primary: 'rgb(var(--primary-soft))',
  emerald: 'rgb(var(--emerald-soft))',
  amber: 'rgb(var(--amber-soft))',
  sky: 'rgb(var(--sky-soft))',
  rose: 'rgb(var(--rose-soft))',
  ink: 'rgb(var(--surface-2))',
};

export const GRID = 'rgb(var(--border) / 0.8)';
export const AXIS = 'rgb(var(--border-strong))';
export const SURFACE = 'rgb(var(--surface))';
export const INK_FAINT = 'rgb(var(--ink-faint))';
export const INK_MUTED = 'rgb(var(--ink-muted))';

/** Paleta para varias series cuando nadie pone color: la marca primero, luego las demás. */
export const SERIES_ORDER: ChartTone[] = ['primary', 'sky', 'emerald', 'amber', 'rose'];

/** Color por nombre de estado: terminado, atrasado, en riesgo, planeado. */
export const STATUS_TONE = {
  done: 'emerald',
  delayed: 'amber',
  risk: 'rose',
  planned: 'primary',
  info: 'sky',
} as const satisfies Record<string, ChartTone>;
