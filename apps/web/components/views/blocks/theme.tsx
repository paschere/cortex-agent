'use client';

import { hueDistance, hueOf } from '@/lib/branding/colors';
import type { ViewBrand } from '@/lib/branding/shape';
import type { ComputedTheme, Tone } from '@cortex/agent-tools';
import { clsx } from 'clsx';
import { createContext, useContext } from 'react';

/**
 * EL ASPECTO DE UNA VISTA, REPARTIDO A SUS BLOQUES.
 *
 * `spec.theme` elige un acento de los cinco tonos, una densidad y una
 * cabecera; aquí se vuelve contexto para que cada bloque lo lea sin pasarlo de
 * mano en mano. Todo son tokens del sistema de diseño (`bg-primary-soft`,
 * `rounded-card`…): ni colores libres ni CSS del spec. Por eso la misma vista
 * se ve oscura dentro del espacio y clara en el enlace público sin una línea
 * más — los tokens cambian solos con `.cortex-workspace` — y con el color de
 * la empresa sin que ningún bloque lo sepa: `primary` ES la marca dentro de
 * `.cortex-brand` (ver brand.tsx y views.css).
 *
 * También viven aquí el marco de cada bloque (`Card`) y los mapas tono →
 * clase, que comparten el lienzo y los bloques de components/views/blocks.
 */

export const DEFAULT_THEME: ComputedTheme = {
  accent: 'primary',
  density: 'comfortable',
  header: 'plain',
  layout: 'dashboard',
  style: 'clean',
  cover: null,
};

const ThemeContext = createContext<ComputedTheme>(DEFAULT_THEME);

export function ViewThemeProvider({
  theme,
  children,
}: {
  theme: ComputedTheme | undefined;
  children: React.ReactNode;
}) {
  return <ThemeContext.Provider value={theme ?? DEFAULT_THEME}>{children}</ThemeContext.Provider>;
}

export function useViewTheme(): ComputedTheme {
  return useContext(ThemeContext);
}

export const TONE_TEXT: Record<Tone, string> = {
  primary: 'text-primary',
  emerald: 'text-emerald',
  amber: 'text-amber',
  sky: 'text-sky',
  rose: 'text-rose',
};
export const TONE_BAR: Record<Tone, string> = {
  primary: 'bg-primary',
  emerald: 'bg-emerald',
  amber: 'bg-amber',
  sky: 'bg-sky',
  rose: 'bg-rose',
};
export const TONE_SOFT: Record<Tone, string> = {
  primary: 'bg-primary-soft text-primary',
  emerald: 'bg-emerald-soft text-emerald',
  amber: 'bg-amber-soft text-amber',
  sky: 'bg-sky-soft text-sky',
  rose: 'bg-rose-soft text-rose',
};
export const TONE_RING: Record<Tone, string> = {
  primary: 'border-primary/40',
  emerald: 'border-emerald/40',
  amber: 'border-amber/40',
  sky: 'border-sky/40',
  rose: 'border-rose/40',
};

/** El punto de color de un tono (leyendas, columnas, estados). */
export const TONE_DOT = TONE_BAR;

/**
 * El color de un tono como valor CSS, para lo que se dibuja en SVG o con
 * `style`: el acento usa `--view-fill` (el color de la marca para dibujar,
 * ver views.css), los demás su token.
 */
export const TONE_COLOR: Record<Tone, string> = {
  primary: 'rgb(var(--view-fill, var(--primary)))',
  emerald: 'rgb(var(--emerald))',
  amber: 'rgb(var(--amber))',
  sky: 'rgb(var(--sky))',
  rose: 'rgb(var(--rose))',
};
/** El segundo color de la marca (o `sky` sin marca), para la segunda serie. */
export const SECOND_COLOR = 'rgb(var(--view-fill-2, var(--sky)))';

/** El tono aproximado de cada token (en claro y en oscuro se parecen). */
const TOKEN_HUE: Record<Exclude<Tone, 'primary'>, number> = {
  sky: 200,
  emerald: 160,
  amber: 28,
  rose: 345,
};

/**
 * Los colores de una serie de gráfico, empezando por el tono del bloque, sin
 * repetir. Con marca, después de sus dos colores van los tonos del sistema
 * MÁS LEJANOS de ellos: una marca verde azulado no pone «esmeralda» al lado
 * de su verde, donde nadie distinguiría los trozos de una dona.
 */
export function seriesColors(tone: Tone, brand?: ViewBrand | null): string[] {
  const brandHues = [brand?.primary, brand?.secondary]
    .map((h) => (h ? hueOf(h) : null))
    .filter((h): h is number => h !== null);
  const rest = (Object.keys(TOKEN_HUE) as Array<keyof typeof TOKEN_HUE>)
    .map((t) => ({
      t,
      far: brandHues.length ? Math.min(...brandHues.map((h) => hueDistance(h, TOKEN_HUE[t]))) : 0,
    }))
    .sort((a, b) => b.far - a.far)
    .map(({ t }) => TONE_COLOR[t]);
  const order = brandHues.length
    ? [TONE_COLOR[tone], tone === 'primary' ? SECOND_COLOR : TONE_COLOR.primary, ...rest]
    : [
        TONE_COLOR[tone],
        tone === 'primary' ? SECOND_COLOR : TONE_COLOR.primary,
        TONE_COLOR.emerald,
        TONE_COLOR.amber,
        TONE_COLOR.rose,
        TONE_COLOR.sky,
      ];
  return [...new Set(order)];
}

/**
 * EL TONO DE UN ESTADO, POR SU NOMBRE. «Pagada», «Entregado», «Vencida»,
 * «Pendiente»: palabras que en español de oficina ya dicen su color. Lo que no
 * se reconoce queda neutro — inventarle un color sería inventarle un sentido.
 */
const STATUS_WORDS: Array<[RegExp, Tone]> = [
  [
    /vencid|cancelad|rechazad|bloquead|perdid|mora|atrasad|fall|error|anulad|urgente|cr[ií]tic|alta\b/i,
    'rose',
  ],
  // Lo negado antes que lo positivo: «Inactivo», «No pagada» no son verdes.
  [/\binactiv|incomplet|sin pagar|no pagad|no entregad/i, 'amber'],
  [
    /pendiente|revisi[oó]n|espera|proceso|curso|alistando|borrador|parcial|riesgo|media\b|taller/i,
    'amber',
  ],
  [
    /pagad|entregad|aprobad|activ|complet|cerrad|listo|lista|confirmad|al d[ií]a|ganad|resuelt|disponible|hecho|baja\b/i,
    'emerald',
  ],
  [/nuev|programad|ruta|enviad|abiert|recibid/i, 'sky'],
];
export function statusTone(value: string): Tone | null {
  const v = value.trim();
  if (!v || v.length > 32) return null;
  for (const [re, tone] of STATUS_WORDS) if (re.test(v)) return tone;
  return null;
}

/** Columnas que se pintan como chips de estado aunque el valor no se reconozca. */
export const STATUS_COLUMN_RE = /^(estado|status|etapa|fase|prioridad|situaci[oó]n|resultado)$/i;

export function StatusChip({ value, tone }: { value: string; tone: Tone | null }) {
  return (
    <span
      className={clsx(
        'inline-flex max-w-full items-center gap-1.5 whitespace-nowrap rounded-pill px-2.5 py-0.5 text-micro font-semibold',
        tone ? TONE_SOFT[tone] : 'bg-surface-2 text-ink-muted',
      )}
    >
      <span
        aria-hidden
        className={clsx(
          'h-1.5 w-1.5 shrink-0 rounded-pill',
          tone ? TONE_BAR[tone] : 'bg-ink-faint',
        )}
      />
      <span className="truncate">{value}</span>
    </span>
  );
}

export function Card({
  title,
  source,
  children,
  className,
  action,
}: {
  title?: string;
  source?: string;
  children: React.ReactNode;
  className?: string;
  /** Algo a la derecha del título (la navegación del calendario). */
  action?: React.ReactNode;
}) {
  const { density } = useViewTheme();
  return (
    <div
      className={clsx(
        'view-card h-full min-w-0 rounded-card border border-border bg-surface shadow-card',
        density === 'compact' ? 'p-3.5 sm:p-4' : 'p-4 sm:p-6',
        className,
      )}
    >
      {(title || source || action) && (
        <header
          className={clsx(
            'flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5',
            density === 'compact' ? 'mb-3' : 'mb-4',
          )}
        >
          {title && (
            <h2 className="min-w-0 text-base font-bold leading-snug tracking-tight text-ink">
              {title}
            </h2>
          )}
          {action}
          {source && !action && (
            <span className="max-w-full shrink-0 truncate rounded-pill bg-surface-2 px-2.5 py-0.5 text-micro font-medium text-ink-faint">
              {source}
            </span>
          )}
        </header>
      )}
      {children}
    </div>
  );
}

/** Un bloque sin nada que mostrar: qué va ahí, sin dramatismo. */
export function EmptyState({
  icon,
  title,
  hint,
  className,
}: {
  icon?: React.ReactNode;
  title: string;
  hint?: string;
  className?: string;
}) {
  return (
    <div
      className={clsx(
        'flex flex-col items-center justify-center gap-2 rounded-sm border border-dashed border-border px-4 py-8 text-center',
        className,
      )}
    >
      {icon && (
        <span className="grid h-10 w-10 place-items-center rounded-pill bg-surface-2 text-ink-faint">
          {icon}
        </span>
      )}
      <p className="text-sm font-semibold text-ink-muted">{title}</p>
      {hint && <p className="max-w-xs text-xs leading-relaxed text-ink-faint">{hint}</p>}
    </div>
  );
}

const VIEW_WHEN = new Intl.DateTimeFormat('es-CO', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'America/Bogota',
});

/** Fecha y hora de Bogotá, corta: «28 sep 2026, 12:00 p. m.». Una fecha rota es «—», no un error. */
export function formatWhen(iso: string): string {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? '—' : VIEW_WHEN.format(new Date(t));
}

/** «octubre de 2026» → «Octubre de 2026»: sólo la primera letra (`capitalize` de CSS haría «De»). */
export function upperFirst(text: string): string {
  return text.charAt(0).toLocaleUpperCase('es-CO') + text.slice(1);
}

/** Un día AAAA-MM-DD a «Lun, 28 sep». */
export function shortDay(day: string): string {
  return upperFirst(
    new Intl.DateTimeFormat('es-CO', {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      timeZone: 'UTC',
    }).format(new Date(`${day}T12:00:00Z`)),
  );
}
