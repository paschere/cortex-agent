'use client';

import { useEffect, useState } from 'react';
import { Presence, type PresenceState } from './Presence';

/**
 * QUÉ ESTÁ PASANDO AHORA MISMO, DICHO POR LA MISMA PRESENCIA QUE LO HACE.
 *
 * Sustituye a `TypingIndicator`, que eran tres puntos grises dentro de una
 * tarjeta con borde y sombra. Dos cosas cambian, y las dos son la misma idea:
 *
 *   NO ES UNA TARJETA. Esto no es contenido de la conversación, es el estado
 *   de quien la sostiene — y la profundidad de esta app está reservada para lo
 *   que se puede leer, citar o pulsar. Un rectángulo con sombra alrededor de
 *   «Trabajando…» compite con la respuesta que está a punto de aparecer justo
 *   debajo.
 *
 *   NO ES UN OBJETO DISTINTO DEL AVATAR. Es `Presence`, la misma que se queda
 *   al lado del mensaje cuando termina. No desaparece un spinner y aparece una
 *   burbuja: se calma lo que estaba girando. Ver `Presence.tsx`.
 *
 * ===========================================================================
 * EL CONTADOR, Y CUÁNDO NO
 * ===========================================================================
 * `TaskRows` ya cronometra cada llamada en su propia fila, y su comentario
 * rechaza con razón tener «una segunda medición compitiendo con la primera».
 * Así que aquí el contador aparece SÓLO cuando no hay ninguna herramienta con
 * nombre — el preludio: el rato entre que mandas la pregunta y la primera
 * llamada, que no lo cuenta nadie y que en un turno con contexto largo son
 * varios segundos de silencio absoluto.
 *
 * Y aparece a los cuatro segundos, no antes. Un cronómetro sobre una espera de
 * medio segundo convierte en incidente lo que era una respuesta rápida.
 */

/** Cuánto silencio hay que aguantar antes de que la cifra ayude más de lo que asusta. */
const SHOW_ELAPSED_AFTER_MS = 4000;

export function LiveStatus({
  state,
  label,
  /** true cuando hay una herramienta con nombre: entonces el número lo lleva su fila. */
  counted = false,
}: {
  state: Extract<PresenceState, 'thinking' | 'working'>;
  label: string;
  counted?: boolean;
}) {
  const elapsed = useElapsed(!counted);

  return (
    // <output> ya es role="status": quien navega escuchando recibe la frase,
    // que es la única parte de esto que se puede anunciar. La presencia va
    // aria-hidden justamente para no decir lo mismo dos veces.
    // EN EL CARRIL, AL PÍXEL. `w-7` y `gap-3 sm:gap-4` son los mismos que la
    // columna de evidencia de una respuesta, y por eso la presencia deja de
    // saltar: donde está girando ahora es exactamente donde se va a quedar
    // quieta al lado de la respuesta. Era `md` y suelta, ocho píxeles más
    // grande y en otra x — o sea, dos objetos, que es justo lo que Presence.tsx
    // dice que no puede ser.
    <output className="flex items-center gap-3 py-0.5 sm:gap-4" aria-live="polite">
      <span className="grid w-7 shrink-0 place-items-center">
        <Presence size="sm" state={state} />
      </span>
      <span className="flex items-baseline gap-2">
        <span className="text-sm font-medium text-ink-muted">{label}</span>
        {elapsed !== null && (
          <span className="tabular-nums font-mono text-micro text-ink-faint">{elapsed}s</span>
        )}
      </span>
    </output>
  );
}

/**
 * Segundos desde que esto se montó, o null mientras no toque enseñarlos.
 *
 * Se monta cuando arranca el turno y se desmonta cuando termina, así que el
 * origen es el momento correcto sin que nadie tenga que pasarlo. El intervalo
 * sólo existe mientras `on`, de modo que un turno con herramienta —el caso
 * normal— no deja ningún temporizador corriendo.
 */
function useElapsed(on: boolean): number | null {
  const [seconds, setSeconds] = useState<number | null>(null);

  useEffect(() => {
    if (!on) {
      setSeconds(null);
      return;
    }
    const startedAt = Date.now();
    const id = setInterval(() => {
      const ms = Date.now() - startedAt;
      setSeconds(ms >= SHOW_ELAPSED_AFTER_MS ? Math.round(ms / 1000) : null);
    }, 500);
    return () => clearInterval(id);
  }, [on]);

  return seconds;
}
