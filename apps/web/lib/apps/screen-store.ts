'use client';

import {
  type ScreenMeta,
  listEntryName,
  pickScreen,
  screenCacheKey,
} from '@/lib/apps/screen-cache';
import { type StoredScreen, loadScreens, putScreen } from '@/lib/views/offline-store';
import type { ComputedView } from '@cortex/agent-tools';

/**
 * Guardar y leer la última copia de las pantallas de una app en este teléfono
 * (ver lib/apps/screen-cache.ts para las reglas). Escribe a lo sumo una vez cada
 * 20 s por pantalla: la vista se refresca sola cada 10–60 s y no hace falta
 * reescribir todo el cálculo en cada vuelta.
 */

const lastWrite = new Map<string, number>();
const MIN_GAP_MS = 20_000;

export interface ScreenWho {
  appKey: string;
  userKey: string;
}

export async function rememberScreen(
  who: ScreenWho & { screen: string; title: string },
  computed: ComputedView,
): Promise<void> {
  const key = screenCacheKey(who.appKey, who.userKey, who.screen);
  const now = Date.now();
  if (now - (lastWrite.get(key) ?? 0) < MIN_GAP_MS) return;
  lastWrite.set(key, now);
  try {
    await putScreen({
      key,
      appKey: who.appKey,
      userKey: who.userKey,
      screen: who.screen,
      title: who.title,
      savedAt: now,
      computed,
    });
  } catch {}
}

export interface SavedScreen {
  screen: string;
  title: string;
  savedAt: number;
  computed: ComputedView;
}

export async function recallScreen(who: ScreenWho, screen: string): Promise<SavedScreen | null> {
  try {
    const all = await loadScreens();
    const hit = pickScreen<ScreenMeta & StoredScreen>(all, who, screen, Date.now());
    return hit
      ? {
          screen: hit.screen,
          title: hit.title,
          savedAt: hit.savedAt,
          computed: hit.computed as ComputedView,
        }
      : null;
  } catch {
    return null;
  }
}

/**
 * La última lista de opciones de una relación (los clientes, los equipos) para
 * poder elegir sin señal. Va en el mismo almacén que las pantallas (misma
 * persona, misma app, mismas reglas de borrado y caducidad). Sólo la lista
 * completa (sin búsqueda): con señal siempre manda el servidor.
 */
export async function rememberList(who: ScreenWho, url: string, options: unknown): Promise<void> {
  const name = listEntryName(url);
  const key = screenCacheKey(who.appKey, who.userKey, name);
  const now = Date.now();
  if (now - (lastWrite.get(key) ?? 0) < MIN_GAP_MS) return;
  lastWrite.set(key, now);
  try {
    await putScreen({
      key,
      appKey: who.appKey,
      userKey: who.userKey,
      screen: name,
      title: '',
      savedAt: now,
      computed: options,
    });
  } catch {}
}

export async function recallList<T>(
  who: ScreenWho,
  url: string,
): Promise<{ options: T[]; savedAt: number } | null> {
  try {
    const all = await loadScreens();
    const hit = pickScreen<ScreenMeta & StoredScreen>(all, who, listEntryName(url), Date.now());
    return hit && Array.isArray(hit.computed)
      ? { options: hit.computed as T[], savedAt: hit.savedAt }
      : null;
  } catch {
    return null;
  }
}
