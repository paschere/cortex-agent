'use client';

import { FramePool, type PoolSnapshot } from '@/lib/apps/code-frame-pool';
import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useSyncExternalStore,
} from 'react';

/**
 * EL ANFITRIÓN DE LOS IFRAMES VIVOS.
 *
 * Se pone en un layout que NO se desmonta al navegar de una pantalla a otra de la app
 * (`/apps/<app>/layout.tsx`, `/panel/apps/<app>/vista/layout.tsx`). Los iframes de las últimas
 * pantallas con código visitadas viven aquí, en una capa `absolute` dentro de un contenedor
 * `relative`: el activo se dibuja exactamente sobre el hueco que deja su `CodeScreen`; los
 * demás quedan ocultos (`visibility: hidden`, sin eventos) pero montados y con su estado.
 *
 * Por qué no se mueven con un portal: un iframe que cambia de padre en el DOM se recarga. Por eso
 * el iframe nunca cambia de lugar; lo que se mueve es su rectángulo.
 *
 * Sin anfitrión en el árbol (cualquier otro uso de `CodeScreen`), `CodeScreen` se envuelve en uno
 * propio de UN solo marco: el comportamiento de siempre.
 */

const Ctx = createContext<FramePool | null>(null);

export function useFramePool(): FramePool | null {
  return useContext(Ctx);
}

export function usePoolSnapshot(pool: FramePool): PoolSnapshot {
  return useSyncExternalStore(pool.subscribe, pool.getSnapshot, pool.getServerSnapshot);
}

export function CodeFrameHost({
  children,
  max,
  className,
}: {
  children: ReactNode;
  /** Cuántos marcos se mantienen; por omisión 4. */
  max?: number;
  className?: string;
}) {
  const poolRef = useRef<FramePool | null>(null);
  if (!poolRef.current) poolRef.current = new FramePool(max);
  const pool = poolRef.current;
  const wrap = useRef<HTMLDivElement>(null);
  const snap = usePoolSnapshot(pool);

  useEffect(() => {
    if (wrap.current) pool.attach(wrap.current);
    return () => pool.destroy();
  }, [pool]);

  return (
    <Ctx.Provider value={pool}>
      <div ref={wrap} className={className ? `relative ${className}` : 'relative'}>
        {children}
        {/* La capa de marcos: no atrapa clics salvo en el marco activo. */}
        <div aria-hidden={false} className="pointer-events-none absolute inset-0 z-[1]">
          {snap.frames.map((f) => (
            <FrameIframe key={f.id} pool={pool} frame={f} />
          ))}
        </div>
      </div>
    </Ctx.Provider>
  );
}

function FrameIframe({
  pool,
  frame,
}: {
  pool: FramePool;
  frame: PoolSnapshot['frames'][number];
}) {
  const rect = frame.rect;
  const ref = useCallback(
    (el: HTMLIFrameElement | null) => pool.setIframe(frame.id, el),
    [pool, frame.id],
  );
  const visible = frame.active && rect !== null && !frame.failed;
  return (
    <iframe
      // Un reintento cambia `attempt` y con él la key: el iframe se vuelve a crear.
      key={`${frame.id}:${frame.attempt}`}
      ref={ref}
      title={`Pantalla ${frame.screen}`}
      src={frame.src}
      sandbox="allow-scripts allow-forms allow-popups allow-downloads"
      onLoad={() => pool.onFrameLoad(frame.id)}
      tabIndex={visible ? undefined : -1}
      aria-hidden={visible ? undefined : true}
      className="absolute rounded-card border-0 bg-transparent transition-opacity duration-200 ease-out motion-reduce:transition-none"
      style={{
        // Oculto, conserva el último tamaño: así no se vuelve a acomodar por dentro al volver.
        left: rect?.x ?? 0,
        top: rect?.y ?? 0,
        width: rect?.w ?? 1,
        height: rect?.h ?? 1,
        opacity: visible && frame.shown ? 1 : 0,
        visibility: visible ? 'visible' : 'hidden',
        pointerEvents: visible ? 'auto' : 'none',
      }}
    />
  );
}
