import type { SupabaseClient } from '@supabase/supabase-js';
import { isReadOnlySource } from '../views/spec';
import { type ComputedHome, HOME_SLUG, computeHome, homeEnabled } from './appearance';
import { canCreateIn } from './permissions';
import {
  type AppAccess,
  type AppScreenRow,
  type ScreenRead,
  screenViews,
  visibleScreens,
} from './store';

/**
 * Lo que una pantalla de app añade al lienzo (0215): el menú con «Inicio», el
 * Inicio calculado y las guías de los bloques vacíos. Vive aquí, y no en las
 * páginas, porque /apps/<app>/<pantalla> y /a/<app>/<pantalla> lo piden igual.
 */

export const HOME_NAV = { slug: HOME_SLUG, title: 'Inicio', icon: 'Home' } as const;

/** El menú que ve este rol: «Inicio» de primera si la app lo tiene encendido. */
export function navScreens(
  access: AppAccess,
): Array<{ slug: string; title: string; icon: string }> {
  const screens = visibleScreens(access).map((s) => ({
    slug: s.slug,
    title: s.title,
    icon: s.icon,
  }));
  return homeEnabled(access.app.home) ? [{ ...HOME_NAV }, ...screens] : screens;
}

/** ¿Esta ruta es la pantalla «Inicio» de una app que lo tiene? */
export function isHomeRoute(access: AppAccess, screenRef: string | null | undefined): boolean {
  return screenRef === HOME_SLUG && homeEnabled(access.app.home);
}

/** A dónde abre la app: el Inicio si lo tiene, si no su pantalla de siempre (null = ninguna). */
export function entrySlug(access: AppAccess, firstScreen: AppScreenRow | null): string | null {
  return homeEnabled(access.app.home) ? HOME_SLUG : (firstScreen?.slug ?? null);
}

/** El Inicio de este rol, o null si la app no lo tiene. */
export async function loadHome(
  db: SupabaseClient,
  access: AppAccess,
  now: Date = new Date(),
): Promise<ComputedHome | null> {
  const home = access.app.home;
  if (!homeEnabled(home)) return null;
  return computeHome(db, access, home, new Set(visibleScreens(access).map((s) => s.slug)), now);
}

export interface EmptyHintData {
  blockId: string;
  title: string;
  screen: string | null;
  screenTitle: string | null;
}

/** Cuántas guías de «aún no hay nada» se muestran como mucho en una pantalla. */
const MAX_EMPTY_HINTS = 2;

/**
 * Las tablas vacías de ESTA pantalla y a dónde ir a llenarlas: la pantalla del
 * rol que tiene un formulario sobre la misma tabla (y deja crear). Si el
 * formulario está en esta misma pantalla, no se manda a ningún lado. Una tabla
 * que el rol no puede llenar sólo lleva el aviso.
 */
export async function emptyHintsFor(
  db: SupabaseClient,
  access: AppAccess,
  screen: AppScreenRow,
  read: Pick<ScreenRead, 'view' | 'computed'>,
): Promise<EmptyHintData[]> {
  const empty = read.computed.blocks.flatMap((b) =>
    b.type === 'table' && b.total === 0 ? [b] : [],
  );
  if (!empty.length) return [];
  const spec = read.view.spec;
  const others = visibleScreens(access).filter((s) => s.id !== screen.id);
  const views = await screenViews(db, others).catch(() => null);
  const out: EmptyHintData[] = [];
  for (const block of empty.slice(0, MAX_EMPTY_HINTS)) {
    const tracker = spec.blocks.find((b) => b.id === block.id);
    const slug = tracker && 'tracker' in tracker ? tracker.tracker : null;
    const hint: EmptyHintData = {
      blockId: block.id,
      title: block.title,
      screen: null,
      screenTitle: null,
    };
    if (slug && !isReadOnlySource(slug) && canCreateIn(access.role, slug)) {
      const here = spec.blocks.some((b) => b.type === 'form' && b.tracker === slug);
      if (!here) {
        const target = others.find((s) => {
          const v = views?.get(s.view_id);
          return v?.spec.blocks.some((b) => b.type === 'form' && b.tracker === slug);
        });
        if (target) {
          hint.screen = target.slug;
          hint.screenTitle = target.title;
        }
      }
    }
    out.push(hint);
  }
  return out;
}
