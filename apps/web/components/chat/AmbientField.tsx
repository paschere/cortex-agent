'use client';

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
        UNA SOLA LUZ, Y NADA MÁS.

        =====================================================================
        LO QUE HABÍA AQUÍ Y POR QUÉ SE FUE
        =====================================================================
        Había cuatro capas: una aurora cónica girando, una malla de líneas de
        un píxel, un barrido inclinado que cruzaba cada diecinueve segundos y
        tres manchas a la deriva. Cada una tenía su argumento y el conjunto
        estaba mal — lo dijo el dueño al verlo y tenía razón: en pantalla, una
        malla con un lavado azul degradado ES el fondo genérico de cualquier
        SaaS de 2015. No importa que la malla se llamara «instrumento» en un
        comentario; lo que llega a los ojos es la plantilla.

        Y era el único sitio del producto donde se gastaba atrevimiento en algo
        que nadie usa. Esta pantalla existe para que alguien escriba la primera
        pregunta: todo lo que compita con esa caja de texto está de más.

        Queda UNA luz difusa arriba, del color del producto, que se mueve tan
        despacio que no se percibe como movimiento sino como que la habitación
        cambió mientras mirabas. Es lo mínimo que distingue «hay alguien aquí»
        de «esto está apagado», y no dibuja ninguna forma que se pueda seguir
        con la vista.

        (Chanel: antes de salir de casa, mírate al espejo y quítate un
        accesorio. Aquí sobraban tres.)
      */}
      <div /*
          Y VA ABAJO, DETRÁS DEL CONTENIDO, NO ARRIBA.

          Estaba en `-top-[30vh]`, iluminando el tercio superior — que en esta
          pantalla es EXACTAMENTE la parte vacía, porque el bloque se apoya en
          el compositor. Una luz encima de un vacío es lo que hace que algo se
          lea como «degradado de portada»; la misma luz detrás de la marca y las
          tarjetas se lee como que el contenido está iluminado, y deja el aire
          de arriba como lo que es: aire.
        */
        className="absolute -bottom-[25vh] left-1/2 h-[80vh] w-[110vh] -translate-x-1/2 animate-drift-a rounded-pill bg-primary/[0.09] blur-[110px] will-change-transform"
      />
    </div>
  );
}
