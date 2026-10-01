'use client';

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
 * más — los tokens cambian solos con `.cortex-workspace`.
 *
 * También viven aquí el marco de cada bloque (`Card`) y los mapas tono →
 * clase, que comparten el lienzo y los bloques de components/views/blocks.
 */

export const DEFAULT_THEME: ComputedTheme = {
  accent: 'primary',
  density: 'comfortable',
  header: 'plain',
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
        'h-full rounded-card border border-border bg-surface shadow-card',
        density === 'compact' ? 'p-3 sm:p-4' : 'p-4 sm:p-5',
        className,
      )}
    >
      {(title || source || action) && (
        <header
          className={clsx(
            'flex items-baseline justify-between gap-3',
            density === 'compact' ? 'mb-2' : 'mb-3',
          )}
        >
          {title && <h2 className="min-w-0 text-sm font-semibold text-ink">{title}</h2>}
          {action}
          {source && !action && (
            <span className="shrink-0 text-micro text-ink-faint">{source}</span>
          )}
        </header>
      )}
      {children}
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
