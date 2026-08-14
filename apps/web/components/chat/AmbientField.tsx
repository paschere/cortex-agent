'use client';

import { clsx } from 'clsx';
import type { CSSProperties } from 'react';

/**
 * EL FONDO DE LA PANTALLA EN BLANCO, Y DE NINGUNA OTRA.
 *
 * ===========================================================================
 * ESTO ES DECORACIÓN, Y ESA ES LA POSTURA
 * ===========================================================================
 * `docs/design-system.md` dice que el movimiento contesta una pregunta y nunca
 * decora. Esto decora. No hay forma honesta de decirlo de otra manera, y por
 * eso la regla que lo gobierna no es «qué pregunta contesta» sino DÓNDE SE LE
 * PERMITE EXISTIR:
 *
 *     sólo en la pantalla en blanco, que es la única del producto donde no hay
 *     absolutamente nada que leer.
 *
 * En cuanto hay un solo mensaje, desaparece. Entero. No se atenúa ni se queda
 * de fondo tenue: `mode="thread"` no dibuja ni un nodo.
 *
 * La versión anterior era más ambiciosa y estaba equivocada. Encendía la
 * habitación mientras Cortex pensaba y la apagaba al terminar — sobre el papel
 * eso convertía el fondo en señal, y era la misma idea que `Presence` a escala
 * de habitación. En pantalla se veía a payaso: una aurora girando y un barrido
 * cruzando por detrás de una respuesta que alguien está intentando leer. Un
 * argumento correcto sobre un resultado malo sigue siendo un resultado malo, y
 * esta es una herramienta de trabajo antes que una demo.
 *
 * Lo que queda es la primera impresión, que sí importa —este producto se vende
 * como un gerente para tu empresa y ésa es la pantalla que sale en una demo—
 * y que no le cuesta nada a nadie, porque nadie está leyendo ahí.
 *
 * ===========================================================================
 * Y «TECNOLÓGICO» AQUÍ NO ES CIENCIA FICCIÓN
 * ===========================================================================
 * Es INSTRUMENTO: una malla fina, un barrido lento y luz que cambia de tono.
 * Nada de partículas, constelaciones ni mallas en perspectiva — eso es la
 * estética de «una IA», y este producto no vende una IA: vende a alguien que
 * lee tus contratos.
 *
 * Cómo se evita que canse en los segundos que dura la pantalla:
 *
 *   NO HAY BORDES. Todo va desenfocado. Una forma con contorno definido se
 *   convierte en un objeto, y un objeto que se mueve se sigue con la vista.
 *
 *   ES LENTÍSIMO. 23, 31 y 40 segundos por vuelta. Por debajo de ese orden el
 *   movimiento se percibe como movimiento; por encima, como que la luz de la
 *   habitación cambió mientras mirabas.
 *
 *   NO SE REPITE. Las duraciones son primas entre sí: la composición no vuelve
 *   al mismo sitio en doce minutos, y un bucle que se nota es un bucle que se
 *   mira.
 *
 *   NO USA NINGÚN COLOR CON SIGNIFICADO. Sólo `primary` y `sky`. Verde, ámbar
 *   y rosa quieren decir «en vigor», «por vencer» y «vencido» en toda la app;
 *   teñir el aire de ámbar sería avisar de algo en una pantalla donde no pasa
 *   nada.
 *
 * `prefers-reduced-motion` lo congela desde la regla global de `globals.css` y
 * queda un degradado quieto, que es lo que ya era sin moverse.
 */

/**
 * La malla: dos juegos de líneas de un píxel, desvanecidos hacia los bordes.
 *
 * Es lo que hace que esto se lea como un instrumento y no como una acuarela.
 * Al 5% del token `primary`, que es el umbral por debajo del cual una malla se
 * percibe como textura del papel en vez de como una cuadrícula que se puede
 * contar.
 *
 * La máscara elíptica es obligatoria, no un acabado. Una malla que llega al
 * borde de la pantalla dice «aquí termina el lienzo» y convierte el fondo en un
 * objeto; desvanecida, la habitación no tiene paredes visibles.
 */
const MESH: CSSProperties = {
  backgroundImage: [
    'linear-gradient(to right, rgb(var(--primary) / 0.05) 1px, transparent 1px)',
    'linear-gradient(to bottom, rgb(var(--primary) / 0.05) 1px, transparent 1px)',
  ].join(','),
  backgroundSize: '46px 46px',
  WebkitMaskImage: 'radial-gradient(ellipse 78% 62% at 50% 38%, #000 25%, transparent 78%)',
  maskImage: 'radial-gradient(ellipse 78% 62% at 50% 38%, #000 25%, transparent 78%)',
};

export function AmbientField({
  /**
   * `open` es la pantalla en blanco. Cualquier otra cosa no dibuja nada, y ése
   * es todo el contrato de este componente.
   */
  mode = 'thread',
}: { mode?: 'open' | 'thread' }) {
  // Desmontado y no escondido: cinco capas desenfocadas con animaciones
  // infinitas siguen costando GPU aunque estén a opacidad cero, y en una
  // conversación larga esto estaría corriendo para siempre sin que nadie lo
  // vea. Que desaparezca de golpe al mandar la primera pregunta no es un
  // problema: el contenido que entra en su sitio es lo que se está mirando.
  if (mode !== 'open') return null;

  return (
    <div
      aria-hidden
      // `inset-0` sobre el contenedor del chat, no `fixed`: si fuera fijo al
      // viewport, el panel lateral y el rail quedarían dentro de la misma luz y
      // esto dejaría de ser el fondo de la conversación para ser el de la app.
      className="pointer-events-none absolute inset-0 overflow-hidden"
    >
      {/*
        LA AURORA, AL FONDO DEL TODO.

        Un cónico enorme girando cuarenta segundos por vuelta y desenfocado
        hasta que no queda ni una transición dura. Es la capa que separa
        «moderno» de «tenía un degradado»: un cónico cambia de color según el
        ángulo, así que al girar la luz cambia de TONO POR ZONAS en vez de
        desplazarse — que es lo que hace un cielo y no hace un foco. Una vuelta
        entera dura más que esta pantalla, así que nadie llega a ver que gira.
      */}
      <div
        className="absolute left-1/2 top-1/2 h-[160vh] w-[160vh] -translate-x-1/2 -translate-y-1/2 animate-aurora rounded-pill opacity-70 blur-[120px] will-change-transform"
        style={{
          background:
            'conic-gradient(from 0deg, rgb(var(--primary) / 0.16), rgb(var(--sky) / 0.10) 90deg, rgb(var(--primary) / 0.05) 190deg, rgb(var(--sky) / 0.14) 280deg, rgb(var(--primary) / 0.16) 360deg)',
        }}
      />

      <div style={MESH} className="absolute inset-0" />

      {/*
        EL BARRIDO. Una banda ancha e inclinada que cruza la malla y luego se
        ausenta casi la mitad del ciclo — un barrido continuo es un metrónomo:
        el ojo aprende el ritmo y a partir de ahí lo espera. Es la pieza que
        dice «esto está escaneando», que es literalmente lo que Cortex hace con
        los correos, los contratos y las reuniones.
      */}
      <div className="absolute inset-y-0 left-0 w-[26%] animate-sweep bg-gradient-to-r from-transparent via-primary/[0.09] to-transparent blur-2xl will-change-transform motion-reduce:hidden" />

      {/* Las tres manchas: son las que dan la sensación de que la luz entra por
          algún sitio, y de que no es de un solo color. La tercera reutiliza el
          recorrido de la primera con retraso y al revés — una mancha más, y ni
          un keyframe más. */}
      <div className={clsx('absolute inset-0 opacity-[0.75]')}>
        <span className="absolute -left-[18%] -top-[28%] h-[62vh] w-[62vh] animate-drift-a rounded-pill bg-primary/[0.16] blur-[90px] will-change-transform" />
        <span className="absolute -bottom-[26%] -right-[14%] h-[54vh] w-[54vh] animate-drift-b rounded-pill bg-sky/[0.14] blur-[90px] will-change-transform" />
        <span
          className="absolute -right-[8%] top-[22%] h-[38vh] w-[38vh] animate-drift-a rounded-pill bg-primary/[0.11] blur-[90px] will-change-transform"
          style={{ animationDelay: '-9s', animationDirection: 'reverse' }}
        />
      </div>
    </div>
  );
}
