'use client';

import { clsx } from 'clsx';

/**
 * LO QUE HAY AL OTRO LADO DE LA CONVERSACIÓN.
 *
 * ===========================================================================
 * POR QUÉ EXISTE
 * ===========================================================================
 * Cortex sabe con precisión qué está haciendo en cada instante: qué herramienta
 * tiene en vuelo, cuánto lleva, si está razonando, si ya está escribiendo, si
 * espera una decisión que sólo puede tomar una persona. Todo eso ya está en el
 * turno —`busyLabel` lo lee, `TaskRows` lo cronometra, `ConfirmationPrompt` lo
 * bloquea— y hasta hoy se resumía en tres puntos grises y la palabra
 * «Trabajando…».
 *
 * El dueño lo pidió en una frase: que se sienta que le hablas a un robot EN
 * VIVO. Eso no es una animación bonita; es que el estado que el sistema ya
 * conoce se vea, y que sea SIEMPRE EL MISMO OBJETO el que lo lleva.
 *
 * ===========================================================================
 * UN SOLO OBJETO, Y ÉSA ES LA IDEA ENTERA
 * ===========================================================================
 * Este componente es a la vez el indicador de que está trabajando Y el avatar
 * del mensaje que produce. No son dos cosas que se sustituyen: es lo mismo,
 * que deja de girar cuando termina y se queda al lado de su respuesta. Un
 * spinner que desaparece y una burbuja que aparece son dos sucesos; una
 * presencia que se calma es uno solo, y es el que se lee como alguien.
 *
 * Por eso `MessageBubble` monta esto en vez de un icono, y por eso el tamaño
 * pequeño existe.
 *
 * ===========================================================================
 * CINCO ESTADOS, Y NINGUNO SE DISTINGUE SÓLO POR EL MOVIMIENTO
 * ===========================================================================
 * `globals.css` apaga toda animación bajo `prefers-reduced-motion` con un
 * `!important` sobre `*`. Quien pidió que nada se moviera vería cinco estados
 * idénticos si el movimiento fuera lo único que los separa — así que cada uno
 * cambia además el trazo, el relleno o el color, y el movimiento es lo que
 * sobra encima. La misma razón por la que `LiveStatus` siempre lleva una
 * palabra al lado: el texto es el canal que nunca falla.
 */

export type PresenceState =
  /**
   * Terminado. QUIETO DEL TODO, y eso es deliberado: en una conversación de
   * treinta mensajes hay treinta de éstos en pantalla, y treinta cosas
   * latiendo a la vez no es presencia, es una plaga.
   */
  | 'resting'
  /** Razonando, sin herramienta en vuelo. */
  | 'thinking'
  /** Una herramienta corriendo ahí fuera. El único estado que gira. */
  | 'working'
  /** Ya hay texto saliendo. */
  | 'writing'
  /** Parado a propósito: espera una decisión que no es suya. */
  | 'waiting';

const SIZES = {
  sm: { box: 'h-7 w-7', core: 'h-2 w-2', ring: 'inset-0' },
  md: { box: 'h-9 w-9', core: 'h-2.5 w-2.5', ring: 'inset-0' },
} as const;

export function Presence({
  state = 'resting',
  size = 'md',
  className,
}: {
  state?: PresenceState;
  size?: keyof typeof SIZES;
  className?: string;
}) {
  const s = SIZES[size];
  const waiting = state === 'waiting';
  const tone = waiting ? 'amber' : 'primary';

  return (
    // aria-hidden a conciencia: lo que hay que anunciar es la FRASE que este
    // objeto acompaña, y la lleva el <output aria-live> de LiveStatus. Un
    // segundo anuncio del mismo hecho es ruido para quien navega escuchando.
    <span
      aria-hidden
      className={clsx('relative grid shrink-0 place-items-center', s.box, className)}
    >
      {/* El plato: el cuerpo del objeto. Su anillo es lo que separa los estados
          cuando el movimiento está apagado. */}
      <span
        className={clsx(
          'absolute inset-0 rounded-full ring-1 ring-inset transition-[background-color,box-shadow] duration-200',
          waiting ? 'bg-amber-soft ring-amber/30' : 'bg-primary-soft',
          !waiting && (state === 'resting' ? 'ring-primary/15' : 'ring-primary/30'),
        )}
      />

      {/* PENSANDO: un pulso que se expande y se apaga. No gira, porque pensar
          no es ir a ninguna parte. Debajo queda un anillo fijo, que es lo que
          sobrevive cuando las animaciones están apagadas. */}
      {state === 'thinking' && (
        <>
          <span className="absolute inset-0 rounded-full ring-1 ring-inset ring-primary/25" />
          <span className="absolute inset-0 animate-halo rounded-full bg-primary/25" />
        </>
      )}

      {/* TRABAJANDO: el arco. Un gradiente cónico recortado a un anillo con una
          máscara radial — un borde no puede tener un lado más oscuro que otro,
          y un SVG girando sería un nodo más por cada mensaje del historial.
          Con el movimiento apagado se queda quieto pero SIGUE VIÉNDOSE, que es
          justo lo que se necesita de él. */}
      {state === 'working' && (
        <span
          className="absolute inset-0 animate-orbit rounded-full"
          style={{
            background:
              'conic-gradient(from 0deg, rgb(var(--primary) / 0) 0deg, rgb(var(--primary) / 0.15) 180deg, rgb(var(--primary) / 0.95) 340deg, rgb(var(--primary) / 0) 360deg)',
            WebkitMaskImage: 'radial-gradient(closest-side, transparent 68%, #000 70%)',
            maskImage: 'radial-gradient(closest-side, transparent 68%, #000 70%)',
          }}
        />
      )}

      {/* El núcleo. Parpadea al escribir; respira —lento, en ámbar— cuando
          lleva rato parado esperándote, que es el único momento en que hace
          falta decir «no me colgué, te estoy esperando a ti». */}
      <span
        className={clsx(
          'relative rounded-full transition-colors duration-200',
          s.core,
          tone === 'amber' ? 'bg-amber' : 'bg-primary',
          state === 'waiting' && 'animate-breathe',
          state === 'writing' && 'animate-blink',
        )}
      />
    </span>
  );
}
