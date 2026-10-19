'use client';

import { type PrefillSource, type ThenNav, thenHref } from '@/lib/apps/after-submit';
import { useRouter } from 'next/navigation';
import { type ReactNode, createContext, useContext, useMemo } from 'react';

/**
 * «Y luego, abre esta pantalla»: el marco de la app (AppRunner) deja aquí la
 * forma de navegar a otra pantalla de la MISMA app con valores prellenados. Los
 * formularios y los botones lo usan sin saber dónde viven las direcciones de la
 * app (/apps/<slug>, /a/<id> o el panel). Fuera de una app no hay proveedor y
 * `useAppNav()` devuelve null: no pasa nada.
 */
interface AppNav {
  goThen(then: ThenNav, source: PrefillSource): void;
}

const Ctx = createContext<AppNav | null>(null);

export function AppNavProvider({
  base,
  suffix = '',
  children,
}: {
  /** Base de las direcciones de la app, sin barra final. */
  base: string;
  /** «?como=…» de «Ver como…»; vacío en el uso normal. */
  suffix?: string;
  children: ReactNode;
}) {
  const router = useRouter();
  const value = useMemo<AppNav>(
    () => ({
      goThen(then, source) {
        router.push(thenHref(base, then, source, suffix));
      },
    }),
    [router, base, suffix],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAppNav(): AppNav | null {
  return useContext(Ctx);
}
