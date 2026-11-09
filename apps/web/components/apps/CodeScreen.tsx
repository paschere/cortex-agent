'use client';

import { PREFILL_PARAM, decodePrefill } from '@/lib/apps/after-submit';
import type { FramePool } from '@/lib/apps/code-frame-pool';
import { poolContext } from '@/lib/apps/frame-pool';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useLayoutEffect, useRef } from 'react';
import { AppErrorState } from './AppErrorState';
import { useAppNav } from './AppNav';
import { SkeletonBlock } from './AppSkeleton';
import { useAppToast } from './AppToast';
import { CodeFrameHost, useFramePool, usePoolSnapshot } from './CodeFrameHost';

/**
 * UNA PANTALLA CON CÓDIGO (apps con código, fase 1).
 *
 * El código de la pantalla corre en un iframe con origen nulo (`sandbox` sin `allow-same-origin`):
 * no ve cookies, ni la sesión, ni el DOM de Cortex. Para todo lo demás habla con el host por
 * `postMessage` (`{cortex:1, id, op, args}` → `{cortex:1, id, ok, data | error}`).
 *
 * Este componente ya NO es dueño del iframe: es el HUECO donde se dibuja. El iframe vive en
 * `CodeFrameHost` (en el layout de la app, que no se desmonta al navegar) y se queda montado y
 * oculto cuando se pasa a otra pantalla: volver es instantáneo. Aquí se avisa «esta pantalla está
 * a la vista» (`FramePool.activate`), se muestra el esqueleto mientras el marco pinta y se
 * ofrece reintentar si no carga. El puente de mensajes está en `lib/apps/code-frame-bridge.ts`;
 * el canal en vivo y la cola sin señal, en `lib/apps/code-frame-pool.ts`.
 *
 * Solo se atienden mensajes cuyo `event.source` es el iframe de ese marco. Las respuestas van con
 * '*' porque el origen del iframe es nulo; solo se envía la respuesta a lo que pidió.
 */

/** Las demás pantallas con código de la app, para precargar sus bundles y sus rutas. */
export interface CodePrefetch {
  buildId: string;
  screens: Array<{ slug: string; href: string }>;
}

const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

export interface CodeScreenProps {
  /** El identificador de la app en las direcciones (slug o id). */
  appId: string;
  screen: string;
  /** Vista previa de una compilación concreta (solo administradores). */
  build?: string;
  readOnly?: boolean;
  /** «?como=…» de «Ver como…», con el signo de pregunta; vacío en el uso normal. */
  como?: string;
  /** Quién mira (rol y persona): cambia → no se reusa lo guardado de otro. */
  cacheScope?: string;
  /** Pantallas hermanas con código y la compilación publicada, para precargar. */
  prefetch?: CodePrefetch;
}

export function CodeScreen(props: CodeScreenProps) {
  // Con anfitrión (layout de la app) los marcos sobreviven a la navegación; sin él, uno propio de
  // un solo marco: el comportamiento de siempre.
  const pool = useFramePool();
  if (pool) return <CodeSlot {...props} />;
  return (
    <CodeFrameHost max={1}>
      <CodeSlot {...props} />
    </CodeFrameHost>
  );
}

function CodeSlot({
  appId,
  screen,
  build,
  readOnly = false,
  como = '',
  cacheScope = '',
  prefetch,
}: CodeScreenProps) {
  // Siempre hay anfitrión: `CodeScreen` pone uno propio si el layout no lo trae.
  const pool = useFramePool() as FramePool;
  const slot = useRef<HTMLDivElement>(null);
  const nav = useAppNav();
  const toast = useAppToast();
  const router = useRouter();
  const snap = usePoolSnapshot(pool);

  const base = `/api/apps/${encodeURIComponent(appId)}/code/${encodeURIComponent(screen)}`;
  // Lo prellenado con `nav.go({ screen, prefill })` llega a la pantalla como parámetros de su dirección.
  const pre = decodePrefill(useSearchParams()?.get(PREFILL_PARAM));
  delete pre.build;
  const frameQuery = new URLSearchParams(pre);
  if (build) frameQuery.set('build', build);
  const qs = frameQuery.toString();
  const src = `${base}/frame${qs ? `?${qs}` : ''}`;
  const sdkUrl = `${base}/sdk${como}`;
  const ctx = poolContext({ appId, buildId: prefetch?.buildId, scope: cacheScope, como });

  // Esta pantalla pasa a estar a la vista; al salir, su marco queda vivo y oculto.
  useIsoLayoutEffect(() => {
    if (!slot.current) return;
    const id = pool.activate({
      screen,
      src,
      ctx,
      appId,
      sdkUrl,
      cacheScope,
      readOnly,
      como,
      slot: slot.current,
    });
    return () => pool.deactivate(id);
  }, [pool, screen, src, ctx, appId, sdkUrl, cacheScope, readOnly, como]);

  // El marco que está a la vista usa estos controladores (cambian de identidad en cada render).
  useEffect(() => {
    const mine = { nav, toast };
    pool.controls = mine;
    return () => {
      if (pool.controls === mine) pool.controls = null;
    };
  }, [pool, nav, toast]);

  const me = snap.frames.find((f) => f.id === snap.activeId && f.screen === screen);
  const loaded = me?.loaded ?? false;
  const shown = me?.shown ?? false;
  const failed = Boolean(me?.failed) && !loaded;

  // Precarga: con el navegador ocioso, los bundles (y rutas) de las demás pantallas con código.
  useEffect(() => {
    if (!loaded || !prefetch || prefetch.screens.length === 0) return;
    const conn = (
      navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }
    ).connection;
    if (conn?.saveData || /(^|-)2g$/.test(conn?.effectiveType ?? '')) return;
    const links: HTMLLinkElement[] = [];
    const run = () => {
      for (const sc of prefetch.screens) {
        if (sc.slug === screen) continue;
        router.prefetch(sc.href);
        // El css solo existe en algunas; un 404 de prefetch no molesta, pero no se pide a ciegas.
        const l = document.createElement('link');
        l.rel = 'prefetch';
        l.href = `/api/apps/code/bundle/${prefetch.buildId}/${encodeURIComponent(sc.slug)}.js`;
        document.head.appendChild(l);
        links.push(l);
      }
    };
    const w = window as unknown as {
      requestIdleCallback?: (cb: () => void) => number;
      cancelIdleCallback?: (id: number) => void;
    };
    const handle = w.requestIdleCallback
      ? w.requestIdleCallback(run)
      : window.setTimeout(run, 1_500);
    return () => {
      if (w.requestIdleCallback && w.cancelIdleCallback) w.cancelIdleCallback(handle);
      else clearTimeout(handle);
      for (const l of links) l.remove();
    };
  }, [loaded, prefetch, screen, router]);

  return (
    <div
      ref={slot}
      className="relative"
      style={{ height: 'calc(100dvh - 9rem)', minHeight: '28rem' }}
    >
      {failed ? (
        <AppErrorState
          error={new Error(`La pantalla ${screen} no cargó`)}
          reset={() => me && pool.retry(me.id)}
          title="No pudimos cargar esta pantalla"
        />
      ) : (
        /* El esqueleto conserva la altura y se funde cuando el marco ya pintó (no salta). */
        <div
          aria-busy={!shown}
          aria-hidden={shown}
          className="pointer-events-none absolute inset-0 space-y-3 transition-opacity duration-200 ease-out motion-reduce:transition-none"
          style={{ opacity: shown ? 0 : 1 }}
        >
          {!shown && <output className="sr-only">Cargando la pantalla</output>}
          <SkeletonBlock className="h-7 w-44 !rounded-pill" />
          <SkeletonBlock className="h-40 w-full !rounded-card" />
          <SkeletonBlock className="h-40 w-full !rounded-card" />
        </div>
      )}
    </div>
  );
}
