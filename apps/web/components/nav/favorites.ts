'use client';

import {
  type Favorite,
  favoritesKey,
  parseFavorites,
  toggleFavorite as toggle,
} from '@/lib/nav-shape';
import { useCallback, useEffect, useState } from 'react';

/**
 * FAVORITOS: lo que cada persona fija, guardado en su navegador (una llave por
 * persona y por empresa). El rail y las pestañas de área son árboles distintos
 * y comparten esto: cada cambio avisa con un evento de la ventana, y los demás
 * `useFavorites` vuelven a leer. Mientras no haya nada guardado se usan los de
 * por defecto, que el rail publica aquí para que quien fije desde una pestaña
 * parta de lo mismo que está viendo.
 */

const EVENT = 'cortex:favoritos';
let published: Favorite[] = [];

/** Lo que el rail enseña por defecto; lo usa quien fija desde fuera del rail. */
export function publishFavoriteDefaults(list: Favorite[]) {
  if (JSON.stringify(list) === JSON.stringify(published)) return;
  published = list;
  try {
    window.dispatchEvent(new Event(EVENT));
  } catch {}
}

function read(key: string): Favorite[] | null {
  try {
    return parseFavorites(localStorage.getItem(key));
  } catch {
    return null;
  }
}

export function useFavorites(userKey: string, organizationId: string, defaults?: Favorite[]) {
  const key = favoritesKey(userKey, organizationId);
  const [stored, setStored] = useState<Favorite[] | null>(null);
  const [, bump] = useState(0);
  useEffect(() => {
    const sync = () => {
      setStored(read(key));
      bump((n) => n + 1);
    };
    sync();
    window.addEventListener(EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, [key]);

  const list = stored ?? defaults ?? published;
  const has = useCallback((href: string) => list.some((f) => f.href === href), [list]);
  const toggleFav = useCallback(
    (fav: Favorite) => {
      const base = read(key) ?? defaults ?? published;
      const next = toggle(base, fav);
      try {
        localStorage.setItem(key, JSON.stringify(next));
      } catch {}
      setStored(next);
      try {
        window.dispatchEvent(new Event(EVENT));
      } catch {}
    },
    [key, defaults],
  );
  return { list, has, toggle: toggleFav };
}
