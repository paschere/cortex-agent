'use client';

import { clsx } from 'clsx';

/**
 * EL FONDO DE LA CONVERSACIÓN, Y POR QUÉ NO ES UN ADORNO.
 *
 * ===========================================================================
 * LA REGLA QUE ESTO PARECE SALTARSE
 * ===========================================================================
 * `docs/design-system.md` dice que el movimiento contesta una pregunta y nunca
 * decora. Un fondo animado es, por definición, la excepción — así que o
 * contesta algo o no debería existir.
 *
 * Contesta esto: **hay alguien ahí, y ahora mismo está ocupado.** Es la misma
 * idea que `Presence`, a escala de habitación. La luz se aviva mientras Cortex
 * trabaja y se calma cuando termina, de modo que quien está mirando la
 * respuesta —y no el objeto de 36 píxeles que la acompaña— también lo nota.
 * Sin `busy`, esto sería papel pintado y habría que borrarlo.
 *
 * ===========================================================================
 * CÓMO SE EVITA QUE MOLESTE, QUE ES TODO EL DISEÑO
 * ===========================================================================
 * Esta pantalla se abre todos los días y encima hay texto que se lee. Cuatro
 * decisiones, y cada una está para lo mismo:
 *
 *   ES ENORME Y ESTÁ DESENFOCADO. Sin borde no hay nada que seguir con la
 *   vista. Una forma con contorno definido se convierte en un objeto, y un
 *   objeto que se mueve detrás de un párrafo se lee.
 *
 *   ES LENTÍSIMO. 23 y 31 segundos por vuelta. Por debajo de ese orden el
 *   movimiento se percibe como movimiento; por encima se percibe como que la
 *   luz de la habitación cambió mientras leías.
 *
 *   NO SE REPITE. Las dos duraciones son primas entre sí, con recorridos
 *   distintos y en sentidos opuestos: la composición no vuelve al mismo sitio
 *   en doce minutos. Un bucle que se nota es un bucle que se mira.
 *
 *   NO USA NINGÚN COLOR CON SIGNIFICADO. Sólo `primary` y `sky`, que son el
 *   producto y lo informativo. Verde, ámbar y rosa quieren decir «en vigor»,
 *   «por vencer» y «vencido» en toda la app; teñir el aire de ámbar sería
 *   decir que algo va mal en una pantalla donde no pasa nada.
 *
 * Con `prefers-reduced-motion` la regla global de `globals.css` congela las
 * animaciones y esto se queda como lo que ya era sin moverse: un degradado
 * suave. No hay nada que apagar aparte del movimiento.
 */
export function AmbientField({ busy = false }: { busy?: boolean }) {
  return (
    <div
      aria-hidden
      // `inset-0` sobre el contenedor del chat, no `fixed`: si fuera fijo al
      // viewport, el panel lateral y el rail quedarían dentro de la misma luz y
      // esto dejaría de ser el fondo de la conversación para ser el de la app.
      className="pointer-events-none absolute inset-0 overflow-hidden"
    >
      {/*
        La transición de opacidad dura casi dos segundos a propósito. El turno
        más corto de este producto son unas décimas, y una luz que se enciende y
        se apaga a esa velocidad es un parpadeo — justo lo contrario de lo que
        se quiere decir. Así, un turno rápido apenas la insinúa y una consulta
        al RUNT de dieciocho segundos la sostiene entera.
      */}
      <div
        className={clsx(
          'absolute inset-0 transition-opacity duration-[1600ms] ease-out motion-reduce:transition-none',
          busy ? 'opacity-100' : 'opacity-[0.55]',
        )}
      >
        {/* Arriba a la izquierda, la más grande: es la que da la sensación de
            que la luz entra por algún sitio. */}
        <span className="absolute -left-[18%] -top-[28%] h-[62vh] w-[62vh] animate-drift-a rounded-pill bg-primary/[0.13] blur-[90px] will-change-transform" />
        {/* Abajo a la derecha, en `sky` y más tenue: existe para que la luz no
            sea de un solo color, que es lo que la volvería un foco. */}
        <span className="absolute -bottom-[26%] -right-[14%] h-[54vh] w-[54vh] animate-drift-b rounded-pill bg-sky/[0.11] blur-[90px] will-change-transform" />
        {/* La tercera reutiliza el primer recorrido con retraso y al revés: una
            mancha más, y ni un keyframe más. */}
        <span
          className="absolute -right-[8%] top-[22%] h-[38vh] w-[38vh] animate-drift-a rounded-pill bg-primary/[0.09] blur-[90px] will-change-transform"
          style={{ animationDelay: '-9s', animationDirection: 'reverse' }}
        />
      </div>
    </div>
  );
}
