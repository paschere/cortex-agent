'use client';

import { clsx } from 'clsx';
import type { CSSProperties } from 'react';

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
 * TECNOLÓGICO DONDE SE VENDE, TRANQUILO DONDE SE TRABAJA
 * ===========================================================================
 * Hay una tensión real entre dos cosas ciertas. Este producto se vende como un
 * gerente para tu empresa y la primera pantalla es la que se ve en una demo,
 * así que tiene que impresionar. Y este producto lo tiene abierto ocho horas
 * un contador, así que una malla latiendo detrás de un párrafo es lo que
 * impresiona el primer día y se vuelve insoportable el tercero.
 *
 * La salida no es un punto medio, es una separación en tres:
 *
 *   PANTALLA EN BLANCO   todo encendido — malla entera y barrido.
 *   LEYENDO UNA RESPUESTA  malla a un cuarto, ningún barrido. El fondo se
 *                          aparta de lo único que importa, que es el texto.
 *   MIENTRAS PIENSA        la malla sube a dos tercios y el barrido vuelve, a
 *                          un tercio del tiempo.
 *
 * Ese tercer estado es el que convierte esto de decoración en señal, y es la
 * razón por la que se puede ser atrevido sin pagarlo: lo espectacular ocurre
 * cuando NO hay nada que leer, y se retira solo en cuanto lo hay.
 *
 * Y «tecnológico» aquí no es ciencia ficción, es INSTRUMENTO: una malla fina y
 * un barrido lento, que es como se ve algo que está escaneando. Nada de
 * partículas, constelaciones ni líneas que se persiguen — eso es la estética de
 * «una IA» y este producto no vende una IA, vende a alguien que lee tus
 * contratos.
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
/**
 * La malla: dos juegos de líneas de un píxel, desvanecidos hacia los bordes.
 *
 * Es lo que hace que el fondo se lea como un INSTRUMENTO y no como una
 * acuarela — y «instrumento» es exactamente lo que este producto es. No lleva
 * ni un color inventado: son las mismas líneas de un píxel del token `primary`,
 * al 5%, que es el umbral por debajo del cual una malla se percibe como textura
 * del papel en vez de como una cuadrícula que se puede contar.
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
  busy = false,
  /**
   * `open` es la pantalla en blanco: la primera que se ve, la que sale en una
   * demo y la única donde no hay un párrafo que leer. Ahí va el tratamiento
   * entero. En cuanto hay conversación pasa a `thread` y la malla se queda en
   * un tercio y el barrido desaparece — nadie lee un texto con una luz
   * cruzándole por detrás cada diecinueve segundos.
   */
  mode = 'thread',
}: { busy?: boolean; mode?: 'open' | 'thread' }) {
  const open = mode === 'open';
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

        Un cónico enorme, girando cuarenta segundos por vuelta y desenfocado
        hasta que no queda ni una transición dura. Es la capa que hace que esto
        se lea como luz de habitación y no como «un degradado de fondo»: el
        color cambia por zonas en vez de por distancia, que es lo que hace un
        cielo. Va debajo de todo lo demás y nunca se apaga.
      */}
      <div
        className="absolute left-1/2 top-1/2 h-[160vh] w-[160vh] -translate-x-1/2 -translate-y-1/2 animate-aurora rounded-pill opacity-70 blur-[120px] will-change-transform"
        style={{
          background:
            'conic-gradient(from 0deg, rgb(var(--primary) / 0.16), rgb(var(--sky) / 0.10) 90deg, rgb(var(--primary) / 0.05) 190deg, rgb(var(--sky) / 0.14) 280deg, rgb(var(--primary) / 0.16) 360deg)',
        }}
      />

      {/*
        LA MALLA, EN TRES INTENSIDADES Y NO EN DOS.

        Ésta es la parte atrevida, y lo que la salva de ser atrevimiento a secas
        es que no cambia porque sí:

          pantalla en blanco   entera. Es la primera que se ve, la que sale en
                               una demo y la única sin un párrafo que leer.
          conversación quieta  a un cuarto. Estás leyendo; el fondo se aparta.
          conversación activa  a dos tercios. LA HABITACIÓN SE ENCIENDE MIENTRAS
                               PIENSA, y se apaga sola cuando termina.

        El tercer estado es el que convierte todo esto de decoración en señal, y
        es la misma idea que `Presence` dicha con la pantalla entera en vez de
        con un objeto de 36 píxeles. Casi tres segundos de transición: tiene que
        parecer que la luz sube, nunca que se enciende un interruptor.
      */}
      <div
        style={MESH}
        className={clsx(
          'absolute inset-0 transition-opacity duration-[2400ms] ease-out motion-reduce:transition-none',
          open ? 'opacity-100' : busy ? 'opacity-[0.65]' : 'opacity-[0.25]',
        )}
      />

      {/*
        EL BARRIDO. Una banda ancha e inclinada que cruza la malla y luego se
        ausenta casi la mitad del ciclo — un barrido continuo es un metrónomo, y
        el ojo aprende un ritmo y a partir de ahí lo espera.

        Existe en dos momentos y en ninguno estorba: en la pantalla en blanco,
        cada diecinueve segundos; y mientras hay un turno corriendo, EL MISMO
        recorrido a un tercio del tiempo. Eso es lo que dice «está escaneando»,
        que es literalmente lo que Cortex hace con los correos y los contratos.

        Leyendo una respuesta terminada no hay ninguno, que es la única
        condición que este elemento tenía que cumplir.
      */}
      {(open || busy) && (
        <div
          className={clsx(
            'absolute inset-y-0 left-0 w-[26%] bg-gradient-to-r from-transparent to-transparent blur-2xl will-change-transform motion-reduce:hidden',
            busy ? 'animate-sweep-fast via-primary/[0.14]' : 'animate-sweep via-primary/[0.09]',
          )}
        />
      )}

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
        <span className="absolute -left-[18%] -top-[28%] h-[62vh] w-[62vh] animate-drift-a rounded-pill bg-primary/[0.16] blur-[90px] will-change-transform" />
        {/* Abajo a la derecha, en `sky` y más tenue: existe para que la luz no
            sea de un solo color, que es lo que la volvería un foco. */}
        <span className="absolute -bottom-[26%] -right-[14%] h-[54vh] w-[54vh] animate-drift-b rounded-pill bg-sky/[0.14] blur-[90px] will-change-transform" />
        {/* La tercera reutiliza el primer recorrido con retraso y al revés: una
            mancha más, y ni un keyframe más. */}
        <span
          className="absolute -right-[8%] top-[22%] h-[38vh] w-[38vh] animate-drift-a rounded-pill bg-primary/[0.11] blur-[90px] will-change-transform"
          style={{ animationDelay: '-9s', animationDirection: 'reverse' }}
        />
      </div>
    </div>
  );
}
