'use client';

import { pullDistance, pullProgress, pullTriggers } from '@/lib/apps/app-nav';
import { Loader2, RefreshCw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

/**
 * TIRAR HACIA ABAJO PARA ACTUALIZAR (0215), sólo con el dedo.
 *
 * Escucha en la ventana, así que no envuelve nada ni cambia el scroll: el
 * gesto empieza sólo cuando la página está arriba del todo y el dedo baja. El
 * movimiento horizontal (el gesto de «atrás» de iOS y Android) nunca se
 * toca: no se llama a `preventDefault`. Con `prefers-reduced-motion` el
 * indicador aparece sin deslizarse. `onRefresh` devuelve una promesa; el
 * indicador gira hasta que termina (y al menos medio segundo, para que se
 * note).
 */
export function PullToRefresh({ onRefresh }: { onRefresh: () => Promise<void> }) {
  const [distance, setDistance] = useState(0);
  const [busy, setBusy] = useState(false);
  const start = useRef<{ y: number; x: number } | null>(null);
  const latest = useRef(0);
  const run = useRef(onRefresh);
  run.current = onRefresh;
  const busyRef = useRef(false);

  useEffect(() => {
    const onStart = (e: TouchEvent) => {
      const t = e.touches[0];
      if (!t || busyRef.current || window.scrollY > 0) {
        start.current = null;
        return;
      }
      start.current = { y: t.clientY, x: t.clientX };
    };
    const onMove = (e: TouchEvent) => {
      const s = start.current;
      const t = e.touches[0];
      if (!s || !t) return;
      const dy = t.clientY - s.y;
      // Un gesto más horizontal que vertical es de navegación, no un tirón.
      if (Math.abs(t.clientX - s.x) > Math.abs(dy) || window.scrollY > 0) {
        start.current = null;
        latest.current = 0;
        setDistance(0);
        return;
      }
      latest.current = pullDistance(dy);
      setDistance(latest.current);
    };
    const onEnd = async () => {
      const d = latest.current;
      start.current = null;
      latest.current = 0;
      if (!pullTriggers(d)) {
        setDistance(0);
        return;
      }
      busyRef.current = true;
      setBusy(true);
      setDistance(40);
      const floor = new Promise((r) => window.setTimeout(r, 600));
      try {
        await Promise.all([run.current(), floor]);
      } finally {
        busyRef.current = false;
        setBusy(false);
        setDistance(0);
      }
    };
    window.addEventListener('touchstart', onStart, { passive: true });
    window.addEventListener('touchmove', onMove, { passive: true });
    window.addEventListener('touchend', onEnd);
    window.addEventListener('touchcancel', onEnd);
    return () => {
      window.removeEventListener('touchstart', onStart);
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onEnd);
      window.removeEventListener('touchcancel', onEnd);
    };
  }, []);

  if (distance <= 0 && !busy) return null;
  const progress = busy ? 1 : pullProgress(distance);
  return (
    <div
      aria-hidden={!busy}
      className="view-no-print pointer-events-none fixed inset-x-0 top-[env(safe-area-inset-top)] z-40 flex justify-center md:hidden"
      style={{ transform: `translateY(${Math.round(distance)}px)` }}
    >
      <span
        className="grid h-9 w-9 place-items-center rounded-full border border-border bg-surface text-primary shadow-card"
        style={{ opacity: Math.max(0.35, progress) }}
      >
        {busy ? (
          <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
        ) : (
          <RefreshCw
            className="h-4 w-4"
            style={{ transform: `rotate(${Math.round(progress * 270)}deg)` }}
          />
        )}
      </span>
      {busy && <span className="sr-only">Actualizando</span>}
    </div>
  );
}
