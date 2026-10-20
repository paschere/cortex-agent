/**
 * LA ÚLTIMA COPIA DE CADA PANTALLA, PARA VERLA SIN SEÑAL — la parte pura.
 *
 * Una app en la bodega pierde la señal a cada rato. Cada vez que una pantalla se
 * calcula con éxito, el teléfono guarda su última copia (IndexedDB, ver
 * offline-store.ts); sin señal, ESA copia se muestra con «guardado hace 12
 * min». Reglas que no se negocian (el service worker de Cortex no guarda nada
 * por la misma razón, ver public/sw.js):
 *   - la copia es de UNA persona en UNA app: la llave lleva las dos; otra persona
 *     que entre en el mismo teléfono no ve la de la primera y se la borra;
 *   - al cerrar sesión se borra todo (`clearEverything`);
 *   - nunca se muestra como si fuera fresca: siempre lleva «guardado hace X»;
 *   - caduca a los 7 días y se guardan pocas (las últimas 12 pantallas por app).
 */

import { agoLabel } from '@/lib/apps/offline-cache';

export const SCREEN_MAX_AGE_MS = 7 * 24 * 3_600_000;
export const SCREENS_PER_APP = 12;
/** Las listas de opciones de los formularios (relaciones) viajan en el mismo almacén, con su propio tope. */
export const LISTS_PER_APP = 40;
const LIST_PREFIX = 'list:';

/** ¿Esta copia es una lista de opciones (y no una pantalla)? */
export function isListEntry(screen: string): boolean {
  return screen.startsWith(LIST_PREFIX);
}

/** El «nombre de pantalla» con el que se guarda una lista de opciones (una dirección sin la búsqueda). */
export function listEntryName(url: string): string {
  return `${LIST_PREFIX}${url}`;
}

export interface ScreenMeta {
  key: string;
  appKey: string;
  userKey: string;
  screen: string;
  savedAt: number;
}

export function screenCacheKey(appKey: string, userKey: string, screen: string): string {
  return `${appKey}|${userKey}|${screen}`;
}

/** ¿Todavía vale mostrarla? */
export function isUsable(savedAt: number, now: number): boolean {
  return Number.isFinite(savedAt) && savedAt <= now + 60_000 && now - savedAt <= SCREEN_MAX_AGE_MS;
}

/** «guardado hace 12 minutos». */
export function savedLabel(savedAt: number, now: number): string {
  return `guardado ${agoLabel(new Date(savedAt), new Date(now))}`;
}

/**
 * Qué copias hay que borrar: las de OTRA persona, las caducadas y, de las de
 * esta app, todo lo que pase de `SCREENS_PER_APP` (se conservan las más nuevas).
 */
export function screensToDrop(
  all: readonly ScreenMeta[],
  who: { appKey: string; userKey: string },
  now: number,
): string[] {
  const drop = new Set<string>();
  const mine: ScreenMeta[] = [];
  const lists: ScreenMeta[] = [];
  for (const s of all) {
    if (s.userKey !== who.userKey || !isUsable(s.savedAt, now)) drop.add(s.key);
    else if (s.appKey === who.appKey) (isListEntry(s.screen) ? lists : mine).push(s);
  }
  for (const s of mine.sort((a, b) => b.savedAt - a.savedAt).slice(SCREENS_PER_APP))
    drop.add(s.key);
  for (const s of lists.sort((a, b) => b.savedAt - a.savedAt).slice(LISTS_PER_APP))
    drop.add(s.key);
  return [...drop];
}

/** Elige la copia de una pantalla de ESTA persona en ESTA app; null si no hay una usable. */
export function pickScreen<T extends ScreenMeta>(
  all: readonly T[],
  who: { appKey: string; userKey: string },
  screen: string,
  now: number,
): T | null {
  return (
    all.find(
      (s) =>
        s.appKey === who.appKey &&
        s.userKey === who.userKey &&
        s.screen === screen &&
        isUsable(s.savedAt, now),
    ) ?? null
  );
}
