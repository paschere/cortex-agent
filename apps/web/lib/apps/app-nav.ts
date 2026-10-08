/**
 * LA LÓGICA PURA DEL MARCO DE UNA APP EN EL CELULAR (0215): qué pestañas caben,
 * cuándo se esconde la cabecera, cuánto hay que tirar para refrescar y qué
 * tema elige cada persona. Sin DOM: lo prueba app-nav.test.ts y lo usan los
 * componentes de components/apps/*.
 */

/** Lo que cabe bajo el pulgar. Con más pantallas, la última pestaña es «Más». */
export const MAX_BOTTOM_TABS = 5;

export interface NavScreen {
  slug: string;
  title: string;
  icon: string;
}

/**
 * Hasta cinco pestañas: si hay cinco o menos, todas; si hay más, cuatro y el
 * resto en «Más». La pantalla actual cuenta para el estado activo de «Más» si
 * está entre las escondidas.
 */
export function splitTabs<T extends { slug: string }>(
  screens: T[],
  current: string,
  max = MAX_BOTTOM_TABS,
): { tabs: T[]; more: T[]; moreActive: boolean } {
  if (screens.length <= max) return { tabs: screens, more: [], moreActive: false };
  const tabs = screens.slice(0, max - 1);
  const more = screens.slice(max - 1);
  return { tabs, more, moreActive: more.some((s) => s.slug === current) };
}

/** Cuánto hay que bajar antes de que la cabecera empiece a esconderse. */
export const HEADER_REVEAL_ZONE = 56;
/** Movimiento mínimo (px) que cuenta como intención: un temblor del dedo no esconde nada. */
export const HEADER_SLACK = 8;

/**
 * ¿Debe esconderse la cabecera compacta? Se esconde al bajar (pasada la zona
 * de arranque) y reaparece al subir o al volver arriba. Un movimiento menor al
 * margen deja el estado como estaba.
 */
export function headerHidden(prevY: number, y: number, wasHidden: boolean): boolean {
  if (y <= HEADER_REVEAL_ZONE) return false;
  const dy = y - prevY;
  if (dy > HEADER_SLACK) return true;
  if (dy < -HEADER_SLACK) return false;
  return wasHidden;
}

/** Cuánto hay que tirar (px de pantalla) para que suelte y refresque. */
export const PULL_THRESHOLD = 72;
/** El dedo recorre más de lo que el indicador baja: se siente elástico. */
const PULL_RESISTANCE = 0.5;
export const PULL_MAX = 110;

/** Cuánto baja el indicador para un recorrido `dy` del dedo; 0 si no es un tirón. */
export function pullDistance(dy: number): number {
  if (!(dy > 0)) return 0;
  return Math.min(PULL_MAX, dy * PULL_RESISTANCE);
}

/** 0 a 1: qué tan cerca está el tirón de pasar el umbral. */
export function pullProgress(distance: number): number {
  return Math.max(0, Math.min(1, distance / (PULL_THRESHOLD * PULL_RESISTANCE)));
}

/** ¿Soltar aquí refresca? */
export function pullTriggers(distance: number): boolean {
  return pullProgress(distance) >= 1;
}

export type AppThemeChoice = 'system' | 'light' | 'dark';
export const APP_THEME_KEY = 'cortex-app-theme';

/** Lo guardado → una opción válida; lo que no se entienda es «Sistema» (por defecto una app sigue al sistema). */
export function parseAppTheme(raw: string | null | undefined): AppThemeChoice {
  return raw === 'light' || raw === 'dark' || raw === 'system' ? raw : 'system';
}

/**
 * La dirección a la que lleva una tarjeta del Inicio: la pantalla y, si la
 * tarjeta abre una lista filtrada, el parámetro `f` (`id=valor`, codificado
 * una vez más: es la forma que ya lee el lienzo). `como` es la query de «Ver
 * como…» (empieza en `?`) y se conserva.
 */
export function cardHref(
  base: string,
  como: string,
  card: { screen: string | null; filter: string | null },
): string | null {
  if (!card.screen) return null;
  const parts = [como.replace(/^\?/, ''), card.filter ? `f=${encodeURIComponent(card.filter)}` : '']
    .filter(Boolean)
    .join('&');
  return `${base}/${card.screen}${parts ? `?${parts}` : ''}`;
}
